/* The dependency bundle calls this entry; no game controls are exposed. */
window.AnimaViewerStart = ({ THREE, TWEEN, Viewer, Vec3, io }) => {
  const params = new URLSearchParams(location.search);
  const npc = params.get('npc') || '';
  const sessionId = (params.get('sessionId') || '').slice(0, 128);
  const apiPort = document.querySelector('meta[name="anima-api-port"]').content;
  const possibleParents = [`http://127.0.0.1:${apiPort}`, `http://localhost:${apiPort}`];
  let parentOrigin = possibleParents[0];
  try { const origin = new URL(document.referrer).origin; if (possibleParents.includes(origin)) parentOrigin = origin; } catch {}
  if (possibleParents.includes(params.get('parentOrigin'))) parentOrigin = params.get('parentOrigin');
  const label = document.getElementById('status');
  let status, failed = false, disposed = false, renderer, viewer, controls, orbitCamera, socket, frame, generation = -1;
  let viewCleanup = [];
  const pageCleanup = [];
  let parentVisible = true;
  const visible = () => parentVisible && !document.hidden;
  let lastFrameAt = Date.now(), resumeUntil = 0;
  const resume = () => { loadingAt = lastFrameAt = Date.now(); resumeUntil = lastFrameAt + 5000; lastPostedAt = 0; };
  let hasPosition = false, worldReady = false, chunkCount = 0, lastPositionAt = 0, loadingAt = Date.now();
  let lastPostedAt = 0, positionRevision = 0, lastLivePositionRevision = -1;
  let lastCollisionAt = -Infinity, safeCameraDistance = Infinity;
  const cameraRay = new THREE.Raycaster(), cameraDirection = new THREE.Vector3();
  const labels = { connecting: '连接画面中…', loading: '正在加载真实区块…', live: '实时第三人称', waiting: '等待角色进入世界…', disconnected: '画面连接已断开', error: '画面加载失败' };
  function report(next, message) {
    if (disposed) return;
    if (next === 'live' && failed) return;
    if (status === next && !message) {
      if (next !== 'live' || Date.now() - lastPostedAt < 2000 || positionRevision === lastLivePositionRevision) return;
    }
    status = next; label.dataset.status = next; label.textContent = `${npc || 'NPC'} · ${message || labels[next]}`;
    lastPostedAt = Date.now();
    if (next === 'live') lastLivePositionRevision = positionRevision;
    if (window.parent !== window) window.parent.postMessage({ type: 'anima-viewer-status', npc, sessionId, status: next, message: message || labels[next] }, parentOrigin);
  }
  function fail(message) {
    if (disposed) return;
    failed = true; cancelAnimationFrame(frame); frame = undefined; report('error', message);
  }
  function errorDetail(value) { return String(value?.message || value || '未知错误').replace(/[\r\n]+/g, ' ').slice(0, 220); }
  function quietly(fn) { try { fn(); } catch {} }
  function listen(target, name, handler, options) {
    target.addEventListener(name, handler, options);
    pageCleanup.push(() => target.removeEventListener(name, handler, options));
  }
  function disposeView() {
    const old = viewer; viewer = undefined;
    for (const cleanup of viewCleanup.splice(0)) quietly(cleanup);
    quietly(() => controls?.dispose()); controls = undefined; orbitCamera = undefined;
    if (!old) return;
    // Detach messages before termination. resetAll() would post to dead workers.
    for (const worker of old.world.workers) { worker.onmessage = null; quietly(() => worker.terminate()); }
    old.world.workers = []; old.world.active = false;
    old.world.renderUpdateEmitter?.removeAllListeners();
    const resources = new Set(), objects = new Set();
    const release = resource => {
      if (!resource || resources.has(resource)) return;
      resources.add(resource); quietly(() => resource.dispose?.());
    };
    const material = value => {
      if (!value) return;
      if (Array.isArray(value)) { value.forEach(material); return; }
      for (const property of Object.values(value)) if (property?.isTexture) release(property);
      for (const uniform of Object.values(value.uniforms || {})) if (uniform?.value?.isTexture) release(uniform.value);
      release(value);
    };
    const visit = object => {
      if (!object || objects.has(object)) return;
      objects.add(object); release(object.geometry); material(object.material); release(object.skeleton);
      for (const child of object.children || []) visit(child);
    };
    visit(old.scene);
    for (const object of Object.values(old.world.sectionMeshs || {})) visit(object);
    for (const object of Object.values(old.entities.entities || {})) visit(object);
    for (const object of Object.values(old.primitives?.primitives || {})) visit(object);
    material(old.world.material);
    if (old.scene.background?.isTexture) release(old.scene.background);
    if (old.scene.environment?.isTexture) release(old.scene.environment);
    old.scene.clear?.(); old.entities.entities = {};
    if (old.primitives) old.primitives.primitives = {};
    old.world.sectionMeshs = {}; old.world.loadedChunks = {}; old.world.sectionsOutstanding.clear();
    renderer?.renderLists?.dispose();
  }
  function dispose() {
    if (disposed) return;
    disposed = true; hasPosition = false;
    cancelAnimationFrame(frame); frame = undefined;
    for (const cleanup of pageCleanup.splice(0)) quietly(cleanup);
    socket?.removeAllListeners(); quietly(() => socket?.disconnect());
    TWEEN.removeAll(); disposeView();
    quietly(() => renderer?.dispose()); quietly(() => renderer?.forceContextLoss());
    renderer?.domElement.remove?.();
  }
  function createView() {
    disposeView();
    viewer = new Viewer(renderer);
    const current = viewer, world = current.world;
    const isCurrent = () => !disposed && viewer === current;
    // The upstream XHR callback and texture callback can outlive a dimension.
    // Keep those resources scoped to this view instead of the global loader.
    world.updateTexturesData = () => {
      const abort = new AbortController(); viewCleanup.push(() => abort.abort());
      const loader = new THREE.TextureLoader(new THREE.LoadingManager());
      loader.load(world.texturesDataUrl || `textures/${world.version}.png`, texture => {
        if (!isCurrent()) { texture.dispose(); return; }
        texture.magFilter = texture.minFilter = THREE.NearestFilter; texture.flipY = false;
        world.material.map = texture; world.material.needsUpdate = true;
      }, undefined, error => { if (isCurrent()) fail('画面素材加载失败：' + errorDetail(error)); });
      const states = world.blockStatesData ? Promise.resolve(world.blockStatesData)
        : fetch(`blocksStates/${world.version}.json`, { signal: abort.signal }).then(response => {
          if (!response.ok) throw new Error(`区块素材 HTTP ${response.status}`);
          return response.json();
        });
      states.then(json => {
        if (isCurrent()) for (const worker of world.workers) worker.postMessage({ type: 'blockStates', json });
      }).catch(error => { if (isCurrent() && error.name !== 'AbortError') fail('区块素材加载失败：' + errorDetail(error)); });
    };
    // Keep the user's chosen orbit separate from the temporarily shortened camera.
    orbitCamera = viewer.camera.clone(); controls = new THREE.OrbitControls(orbitCamera, renderer.domElement);
    controls.enablePan = false; controls.minDistance = 2; controls.maxDistance = 40;
    controls.maxPolarAngle = Math.PI * 0.92;
    lastCollisionAt = -Infinity; safeCameraDistance = Infinity;
    for (const worker of viewer.world.workers) {
      const onError = event => { if (isCurrent()) fail('区块渲染错误：' + errorDetail(event)); };
      worker.addEventListener('error', onError);
      viewCleanup.push(() => worker.removeEventListener('error', onError));
    }
  }
  report('connecting');
  if (!/^[A-Za-z0-9_]{1,16}$/.test(npc)) { fail('请选择有效角色。'); return; }
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(innerWidth, innerHeight); document.body.appendChild(renderer.domElement);
    // No Viewer/workers until the first version-bearing reset arrives.
    listen(renderer.domElement, 'webglcontextlost', event => { event.preventDefault(); fail('图形上下文已丢失，请重新打开画面。'); });
    listen(window, 'error', event => fail('画面渲染错误：' + errorDetail(event.error || event.message)));
    listen(window, 'unhandledrejection', event => fail('画面异步错误：' + errorDetail(event.reason)));
    listen(window, 'message', event => {
      const data = event.data;
      if (event.source !== window.parent || event.origin !== parentOrigin || data?.npc !== npc || data.sessionId !== sessionId) return;
      if (data.type === 'anima-viewer-dispose') dispose();
      else if (data.type === 'anima-viewer-visibility' && typeof data.visible === 'boolean') {
        if (data.visible) resume();
        parentVisible = data.visible;
      }
    });
    listen(window, 'pagehide', dispose);
    listen(document, 'visibilitychange', () => {
      // Hidden documents may stop animation entirely. Time spent suspended is
      // not a failed load; on return, allow fresh packets and frames to arrive.
      if (visible()) resume();
    });
    socket = io({ auth: { npc }, transports: ['websocket'], reconnectionDelay: 1000, timeout: 8000 });
    const target = new THREE.Vector3();
    socket.on('connect', () => report('loading'));
    socket.on('connect_error', error => report('error', error.message || '无法连接画面服务。'));
    socket.on('disconnect', () => { hasPosition = false; report('disconnected'); });
    socket.on('viewer-state', event => {
      if (event.npc && event.npc !== npc) return;
      if (event.status === 'error') fail(event.message);
      else if (event.status !== 'live') report(event.status, event.message);
    });
    socket.on('viewer-reset', event => {
      if (disposed || (event.npc && event.npc !== npc)) return;
      generation = event.generation; failed = false; hasPosition = false; worldReady = false; chunkCount = 0; loadingAt = Date.now();
      // Upstream resetWorld leaves pending meshing and loadedChunk bookkeeping.
      // A fresh scene/workers prevent old-dimensional geometry reaching this view.
      TWEEN.removeAll(); disposeView();
      if (event.version) {
        createView();
        if (!viewer.setVersion(event.version)) { fail('不支持当前游戏版本。'); return; }
        report('loading');
        if (frame === undefined) frame = requestAnimationFrame(animate);
      }
    });
    socket.on('position', event => {
      if (!viewer || disposed || event.npc !== npc || event.generation !== generation || !event.pos || !['x', 'y', 'z'].every(k => Number.isFinite(event.pos[k]))) return;
      target.set(event.pos.x, event.pos.y + 1.1, event.pos.z);
      if (!hasPosition) { controls.target.copy(target); orbitCamera.position.set(target.x + 5, target.y + 3, target.z + 6); }
      hasPosition = true; lastPositionAt = Date.now(); positionRevision++;
      viewer.updateEntity({ id: 'anima:self', name: 'player', username: npc, height: 1.8, width: 0.6, pos: event.pos, yaw: event.yaw });
      // The upstream entity tween skips exact zero yaw.
      if (event.yaw === 0 && viewer.entities.entities['anima:self']) viewer.entities.entities['anima:self'].rotation.y = 0;
    });
    socket.on('viewer-world-ready', event => { if (event.generation === generation) worldReady = true; });
    socket.on('loadChunk', event => { if (viewer && !disposed) { chunkCount++; viewer.addColumn(event.x, event.z, event.chunk); } });
    socket.on('unloadChunk', event => viewer?.removeColumn(event.x, event.z));
    socket.on('entity', event => { if (viewer && (!event.delete || viewer.entities.entities[event.id])) viewer.updateEntity(event); });
    socket.on('blockUpdate', event => viewer?.setBlockStateId(new Vec3(event.pos.x, event.pos.y, event.pos.z), event.stateId));
    function positionCamera() {
      cameraDirection.copy(orbitCamera.position).sub(target);
      const distance = cameraDirection.length();
      if (distance < 0.001) return;
      cameraDirection.divideScalar(distance);
      // Only rendered terrain, at most ~7 checks/sec. No server queries, entities,
      // hidden-resource inspection or additional knowledge for the NPC.
      if (Date.now() - lastCollisionAt >= 150) {
        lastCollisionAt = Date.now();
        cameraRay.set(target, cameraDirection); cameraRay.near = 0; cameraRay.far = distance;
        const terrain = Object.values(viewer.world.sectionMeshs || {}).filter(mesh => mesh.geometry?.attributes?.position?.count > 0);
        for (const mesh of terrain) mesh.updateMatrixWorld();
        const hit = cameraRay.intersectObjects(terrain, false)[0];
        safeCameraDistance = hit ? Math.max(0.05, hit.distance - 0.2) : Infinity;
      }
      const actualDistance = Math.min(distance, safeCameraDistance);
      viewer.camera.position.copy(target).addScaledVector(cameraDirection, actualDistance);
      viewer.camera.quaternion.copy(orbitCamera.quaternion);
      // A wall can push the camera inside the followed avatar. Hide only that
      // mesh while close; retain the collision limit and all other entities.
      const self = viewer.entities.entities['anima:self'];
      if (self) self.visible = actualDistance >= 1.25;
    }
    function animate() {
      frame = undefined;
      if (disposed || failed || !viewer) return;
      if (!visible()) { frame = requestAnimationFrame(animate); return; }
      if (Date.now() - lastFrameAt > 5000) resume();
      lastFrameAt = Date.now();
      try {
      if (hasPosition) {
        // Translate camera and orbit centre together; preserve the user's orbit/zoom.
        const delta = target.clone().sub(controls.target); orbitCamera.position.add(delta); controls.target.copy(target);
      }
      controls.update(); if (hasPosition) positionCamera(); viewer.update(); renderer.render(viewer.scene, viewer.camera);
      const fresh = hasPosition && Date.now() - lastPositionAt < 5000;
      // Moving NPCs continuously dirty sections. A real rendered terrain mesh
      // is enough to present the scene while the remaining chunks stream in.
      const terrainReady = viewer.world.sectionsOutstanding.size === 0 || Object.values(viewer.world.sectionMeshs || {}).some(mesh => mesh.geometry?.attributes?.position?.count > 0);
      if (!failed && worldReady && chunkCount > 0 && fresh && terrainReady) report('live');
      else if (status === 'live' && !fresh && Date.now() >= resumeUntil) report('disconnected', '等待新的角色位置…');
      else if (!failed && status === 'loading' && Date.now() - loadingAt > 20000) fail('真实区块尚未完成渲染，请重连画面。');
      } catch (error) { fail('画面渲染错误：' + errorDetail(error)); }
      // Schedule after rendering: a fatal renderer error cannot repeat per frame.
      if (!disposed && !failed) frame = requestAnimationFrame(animate);
    }
    listen(window, 'resize', () => {
      if (viewer) { viewer.camera.aspect = orbitCamera.aspect = innerWidth / innerHeight; viewer.camera.updateProjectionMatrix(); orbitCamera.updateProjectionMatrix(); }
      renderer.setSize(innerWidth, innerHeight);
    });
  } catch (error) { fail(error.message || '无法初始化三维画面。'); dispose(); }
};
