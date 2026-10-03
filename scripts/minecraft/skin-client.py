"""Install pinned Fabric and local-only skins in Anima's isolated Java instance.

No game process is started and no server files or global launcher are changed.
CustomSkinLoader: https://github.com/xfl03/MCCustomSkinLoader (GPL-3.0-only).
"""
import hashlib
import json
import shutil
import urllib.request
from launcher import prepare, save
from setup import ROOT, RUNTIME, VERSION, HEADERS, download

LOADER = '0.16.10'
PROFILE_URL = f'https://meta.fabricmc.net/v2/versions/loader/{VERSION}/{LOADER}/profile/json'
PROFILE_SHA256 = 'a8b6d09f6d4593035275bb080334edf7cddf409aaae91eab3d24fd8639665b04'
MOD_FILE = 'CustomSkinLoader_Universal-15.0.1.jar'
MOD_URL = 'https://cdn.modrinth.com/data/idMHQ4n2/versions/OLaesh5y/' + MOD_FILE
MOD_SHA512 = '8c65193c46c1435ddea571901f1dd04cc179179f59f1c1a0449349de04722b9c1b6e5efaec166975e05d2fa0b05f6c07c9d5d93a05f1c9a57fece2a0d0fc1ce7'
MAIN = 'net.fabricmc.loader.impl.launch.knot.KnotClient'


def install():
    prepare('normal')
    instance = 'Anima-Local-' + VERSION
    game = RUNTIME / 'launcher' / 'instances' / instance
    profile_path = RUNTIME / 'downloads' / f'fabric-{VERSION}-{LOADER}.json'
    download(PROFILE_URL, profile_path, PROFILE_SHA256, 'sha256')
    profile = json.loads(profile_path.read_text(encoding='utf-8'))
    if profile['mainClass'] != MAIN:
        raise ValueError('Unexpected pinned Fabric entry point')
    libraries = []
    for library in profile['libraries']:
        group, artifact, version = library['name'].split(':')
        relative = group.replace('.', '/') + f'/{artifact}/{version}/{artifact}-{version}.jar'
        url = library['url'] + relative
        if not url.startswith('https://maven.fabricmc.net/'):
            raise ValueError('Unexpected Fabric library origin')
        digest = library.get('sha1')
        if not digest:
            with urllib.request.urlopen(urllib.request.Request(url + '.sha1', headers=HEADERS), timeout=30) as response:
                digest = response.read().decode('ascii').strip().split()[0]
        if len(digest) != 40 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError('Invalid Fabric checksum')
        path = game / 'libraries' / relative
        download(url, path, digest)
        libraries.append({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    mod = game / 'mods' / MOD_FILE
    download(MOD_URL, mod, MOD_SHA512, 'sha512')
    textures = game / 'CustomSkinLoader' / 'LocalSkin' / 'skins'
    textures.mkdir(parents=True, exist_ok=True)
    names = ['Sheldon', 'Sherlock', 'Deadpool', 'HuYifei']
    for name in names:
        shutil.copy2(ROOT / 'adapters' / 'minecraft' / 'viewer' / 'skins' / (name + '.png'), textures / (name + '.png'))
    # A custom profile name avoids default-site overrides. No remote skin site
    # is in the loadlist; exact player usernames resolve to repository PNGs.
    save(game / 'CustomSkinLoader' / 'CustomSkinLoader.json', {
        'version': '15.0.1', 'buildNumber': 0,
        'loadlist': [{'name': 'AnimaLocal', 'type': 'Legacy', 'skin': 'LocalSkin/skins/{USERNAME}.png', 'model': 'default'}],
        'enableCape': False, 'forceLoadAllTextures': True, 'enableLogStdOut': True,
        'enableLocalProfileCache': False, 'threadPoolSize': 2})
    metadata_path = game / 'versions' / instance / (instance + '.json')
    metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
    metadata['mainClass'] = MAIN
    metadata['arguments']['jvm'] += profile['arguments']['jvm']
    fabric_names = {':'.join(library['name'].split(':')[:2]) for library in profile['libraries']}
    metadata['libraries'] = profile['libraries'] + [library for library in metadata['libraries'] if ':'.join(library['name'].split(':')[:2]) not in fabric_names]
    save(metadata_path, metadata)
    save(RUNTIME / 'skin-client.json', {'schemaVersion': 1, 'minecraftVersion': VERSION,
         'loaderVersion': LOADER, 'mainClass': MAIN, 'libraries': libraries,
         'mod': {'path': str(mod), 'sha256': hashlib.sha256(mod.read_bytes()).hexdigest()},
         'gameDirectory': str(game), 'players': names,
         'source': 'https://github.com/xfl03/MCCustomSkinLoader'})
    print(f'Local skins installed for {len(names)} NPCs. Fabric {LOADER}; CustomSkinLoader 15.0.1. No client launched.', flush=True)


if __name__ == '__main__':
    install()
