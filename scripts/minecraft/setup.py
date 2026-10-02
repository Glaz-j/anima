"""Download a verified local Java/Minecraft runtime. Client ALWAYS runs in demo mode."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / 'var' / 'minecraft'
VERSION = '1.21.4'
HEADERS = {'User-Agent': 'Anima-Minecraft-local-lab/0.1'}


def read_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=60) as r:
        return json.load(r)


def download(url, destination, digest, algorithm='sha1'):
    destination = Path(destination)
    if destination.exists() and hashlib.new(algorithm, destination.read_bytes()).hexdigest() == digest:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(4):
        temporary = destination.with_suffix(destination.suffix + '.part')
        try:
            hasher = hashlib.new(algorithm)
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=90) as r, temporary.open('wb') as f:
                while chunk := r.read(1024 * 1024):
                    f.write(chunk)
                    hasher.update(chunk)
            if hasher.hexdigest() != digest:
                raise ValueError('Checksum mismatch: ' + destination.name)
            temporary.replace(destination)
            return
        except Exception:
            if attempt == 3:
                raise
            time.sleep(attempt + 1)


def write_once(path, text):
    if not path.exists():
        path.write_text(text, encoding='utf-8')


def allowed(rules):
    if not rules:
        return True
    result = False
    for rule in rules:
        conditions = rule.get('os', {})
        match = conditions.get('name', 'windows') == 'windows'
        match = match and conditions.get('arch', 'x86_64') in ('x86_64', 'amd64')
        if 'version' in conditions:
            match = match and bool(re.search(conditions['version'], os.sys.getwindowsversion().__str__()))
        # The demo feature is the only optional game feature enabled.
        match = match and all({'is_demo_user': True}.get(k, False) == v for k, v in rule.get('features', {}).items())
        if match:
            result = rule['action'] == 'allow'
    return result


def setup(client=False):
    RUNTIME.mkdir(parents=True, exist_ok=True)
    java_manifest = RUNTIME / 'java.json'
    if java_manifest.exists():
        java = json.loads(java_manifest.read_text(encoding='utf-8'))
    else:
        asset = read_json('https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jre&os=windows')[0]
        package = asset['binary']['package']
        java = {'url': package['link'], 'sha256': package['checksum'], 'name': package['name']}
        java_manifest.write_text(json.dumps(java, indent=2), encoding='utf-8')
    print('Downloading/verifying Java 21...', flush=True)
    archive = RUNTIME / java['name']
    download(java['url'], archive, java['sha256'], 'sha256')
    java_dir = RUNTIME / 'java'
    java_dir.mkdir(exist_ok=True)
    java_executable = next(java_dir.glob('*/bin/java.exe'), None)
    if java_executable is None:
        with zipfile.ZipFile(archive) as z:
            z.extractall(java_dir)
        java_executable = next(java_dir.glob('*/bin/java.exe'))

    versions = read_json('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
    version = next(v for v in versions['versions'] if v['id'] == VERSION)
    version_path = RUNTIME / (VERSION + '.json')
    download(version['url'], version_path, version['sha1'])
    metadata = json.loads(version_path.read_text(encoding='utf-8'))
    server = RUNTIME / 'server'
    server.mkdir(exist_ok=True)
    artifact = metadata['downloads']['server']
    print('Downloading/verifying official Minecraft server...', flush=True)
    download(artifact['url'], server / 'server.jar', artifact['sha1'])
    write_once(server / 'eula.txt', '# Minecraft EULA: https://www.minecraft.net/eula\neula=true\n')
    write_once(server / 'server.properties', '\n'.join([
        'server-ip=127.0.0.1', 'server-port=25565', 'online-mode=false',
        'enforce-secure-profile=false', 'motd=Anima local Minecraft lab',
        'max-players=8', 'gamemode=creative', 'difficulty=peaceful',
        'spawn-protection=0', 'view-distance=6', 'simulation-distance=4',
        'level-type=minecraft:flat', 'level-name=world', 'generate-structures=false',
        'generator-settings={"biome":"minecraft:plains","layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},{"block":"minecraft:grass_block","height":1}]}',
        'enable-rcon=false', 'enable-query=false', 'enable-command-block=false',
        'sync-chunk-writes=true', 'pause-when-empty-seconds=-1', ''
    ]))
    runtime_config = {'version': VERSION, 'java': str(java_executable), 'serverJar': str(server / 'server.jar'),
                      'serverDirectory': str(server), 'serverSha1': artifact['sha1']}
    if client:
        prepare_client(metadata, runtime_config)
    config_path = RUNTIME / 'runtime.json'
    if config_path.exists():
        previous = json.loads(config_path.read_text(encoding='utf-8'))
        previous.update(runtime_config)
        runtime_config = previous
    config_path.write_text(json.dumps(runtime_config, indent=2), encoding='utf-8')
    print('Runtime ready: ' + str(config_path), flush=True)


def prepare_client(metadata, runtime_config):
    client = RUNTIME / 'client'
    client.mkdir(exist_ok=True)
    artifact = metadata['downloads']['client']
    print('Downloading/verifying official demo client...', flush=True)
    client_jar = client / 'client.jar'
    download(artifact['url'], client_jar, artifact['sha1'])
    libraries = []
    jobs = []
    for library in metadata['libraries']:
        if not allowed(library.get('rules')):
            continue
        item = library.get('downloads', {}).get('artifact')
        if item:
            path = client / 'libraries' / item['path']
            libraries.append(str(path))
            jobs.append((item['url'], path, item['sha1']))
    index = metadata['assetIndex']
    index_path = client / 'assets' / 'indexes' / (index['id'] + '.json')
    download(index['url'], index_path, index['sha1'])
    objects = json.loads(index_path.read_text(encoding='utf-8'))['objects']
    hashes = sorted({o['hash'] for o in objects.values()})
    for digest in hashes:
        suffix = digest[:2] + '/' + digest
        jobs.append(('https://resources.download.minecraft.net/' + suffix, client / 'assets' / 'objects' / suffix, digest))
    print(f'Downloading/verifying {len(jobs)} libraries/assets...', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
        futures = [executor.submit(download, *job) for job in jobs]
        for i, future in enumerate(concurrent.futures.as_completed(futures), 1):
            future.result()
            if i % 200 == 0 or i == len(jobs):
                print(f'Assets {i}/{len(jobs)}', flush=True)
    natives = client / 'natives'
    natives.mkdir(exist_ok=True)
    for path in libraries:
        with zipfile.ZipFile(path) as archive:
            for member in archive.namelist():
                if member.lower().endswith('.dll'):
                    (natives / Path(member).name).write_bytes(archive.read(member))
    game = client / 'game'
    game.mkdir(exist_ok=True)
    write_once(game / 'options.txt', 'lang:zh_cn\nrenderDistance:6\nsimulationDistance:5\nfullscreen:false\nmaxFps:60\n')
    runtime_config['client'] = {'classpath': os.pathsep.join(libraries + [str(client_jar)]),
                              'mainClass': metadata['mainClass'], 'assets': str(client / 'assets'),
                              'assetIndex': index['id'], 'natives': str(natives), 'gameDirectory': str(game)}


def launch_demo():
    config = json.loads((RUNTIME / 'runtime.json').read_text(encoding='utf-8'))
    c = config.get('client')
    if not c:
        raise RuntimeError('Run npm run minecraft:setup -- --client first.')
    # No authenticated/paid mode is provided: Minecraft itself enforces demo restrictions.
    args = [config['java'], '-Xms512M', '-Xmx2G', '-Djava.library.path=' + c['natives'],
            '-Djna.tmpdir=' + c['natives'], '-Dorg.lwjgl.system.SharedLibraryExtractPath=' + c['natives'],
            '-Dminecraft.launcher.brand=AnimaDemo', '-Dminecraft.launcher.version=0.1',
            '-cp', c['classpath'], c['mainClass'], '--username', 'Player', '--version', config['version'],
            '--gameDir', c['gameDirectory'], '--assetsDir', c['assets'], '--assetIndex', c['assetIndex'],
            '--uuid', '00000000000000000000000000000000', '--accessToken', '0', '--userType', 'legacy',
            '--versionType', 'release', '--demo', '--width', '1280', '--height', '720']
    log = (RUNTIME / 'demo-client.log').open('a', encoding='utf-8')
    process = subprocess.Popen(args, cwd=c['gameDirectory'], stdout=log, stderr=subprocess.STDOUT,
                               creationflags=subprocess.CREATE_NO_WINDOW)
    print(f'Official demo client starting (PID {process.pid}). Log: {RUNTIME / "demo-client.log"}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--client', action='store_true')
    parser.add_argument('--launch-demo', action='store_true')
    options = parser.parse_args()
    if options.launch_demo:
        launch_demo()
    else:
        setup(options.client)
