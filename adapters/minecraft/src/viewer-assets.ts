// prismarine-viewer 1.33 still schedules sections using the pre-1.18 height range.
// Patch the served bundles, leaving installed dependencies untouched.
export function patchViewerBundle(filename: string, source: string) {
  let count = 0;
  let result: string;
  if (filename === 'index.js') {
    result = source.replace(/for\(let ([\w$]+)=0;\1<256;\1\+=16\)/gu, (_match, v) => {
      count += 1;
      return `for(let ${v}=-64;${v}<320;${v}+=16)`;
    });
  } else if (filename === 'worker.js') {
    result = source.replace(/([\w$]+)\.sections\[Math\.floor\(([\w$]+)\/16\)\]/gu, (_match, column, y) => {
      count += 1;
      return `${column}.sections[Math.floor((${y}-(${column}.minY||0))/16)]`;
    });
  } else {
    throw new Error('Unknown viewer bundle');
  }
  if (count !== 2) throw new Error(`Unexpected prismarine-viewer ${filename}: ${count} height loops; check the pinned dependency.`);
  if (filename === 'index.js') {
    // Each worker includes the complete protocol/meshing bundle. Start two, not
    // four, rather than creating expensive workers and immediately killing them.
    const marker = 'WorldRenderer:class{constructor(t,e=4){this.sectionMeshs={},this.active=!1';
    if (result.indexOf(marker) < 0 || result.indexOf(marker) !== result.lastIndexOf(marker)) {
      throw new Error('Unexpected prismarine-viewer WorldRenderer worker constructor; check the pinned dependency.');
    }
    result = result.replace(marker, marker.replace('e=4', 'e=2'));
  }
  return result;
}

// Pinned 1.33.0 webpack entry; retain its renderer/dependencies, replace only
// the application entry. Fail closed on an upstream change. No disk patching.
export function replaceViewerEntry(source: string) {
  const marker = 'i.g.THREE=i(8964);const n=i(484);i(1324);const{Viewer:r,Entity:a}=i(5988),o=i(8007)';
  const offset = source.indexOf(marker);
  if (offset < 0 || source.indexOf(marker, offset + 1) >= 0 || !source.trimEnd().endsWith('})();')) {
    throw new Error('Unexpected prismarine-viewer 1.33.0 entry; review the pinned bundle.');
  }
  return source.slice(0, offset) + "i.g.THREE=i(8964);i(1324);window.AnimaViewerStart({THREE:i(8964),TWEEN:i(484),Viewer:i(5988).Viewer,Vec3:i(742).Vec3,io:i(8007)});})();";
}
