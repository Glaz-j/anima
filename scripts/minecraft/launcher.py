"""Prepare isolated HMCL demo or local Java instances using verified official files."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid

from setup import ROOT, RUNTIME, VERSION, download, setup, write_once

HMCL_VERSION = '3.16.3'
HMCL_SHA256 = '5d02f4d04d9442116354ecfccf679910cca371d00a23cd5d6b16558c20a73dd3'
INSTANCE = 'Anima-Demo-' + VERSION
DIRECTORY_ID = 'game-directory:' + str(uuid.uuid5(uuid.NAMESPACE_URL, 'anima/minecraft/demo'))
ACCOUNT_ID = 'account:' + str(uuid.uuid5(uuid.NAMESPACE_URL, 'anima/minecraft/demo-player'))
PRESET_ID = 'game-settings-preset:' + str(uuid.uuid5(uuid.NAMESPACE_URL, 'anima/minecraft/demo-settings'))


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding='utf-8')


def link_file(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        return
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def prepare(mode='demo'):
    instance = ('Anima-Demo-' if mode == 'demo' else 'Anima-Local-') + VERSION
    directory_id = DIRECTORY_ID if mode == 'demo' else 'game-directory:' + str(uuid.uuid5(uuid.NAMESPACE_URL, 'anima/minecraft/local'))
    account_id = ACCOUNT_ID if mode == 'demo' else 'account:' + str(uuid.uuid5(uuid.NAMESPACE_URL, 'anima/minecraft/observer'))
    player = 'DemoPlayer' if mode == 'demo' else 'AnimaObserver'
    config_path = RUNTIME / 'runtime.json'
    config = json.loads(config_path.read_text(encoding='utf-8')) if config_path.exists() else {}
    if config.get('version') != VERSION or not config.get('client'):
        setup(client=True)
        config = json.loads(config_path.read_text(encoding='utf-8'))
    launcher = RUNTIME / 'launcher'
    jar = launcher / f'HMCL-{HMCL_VERSION}.jar'
    download(f'https://github.com/HMCL-dev/HMCL/releases/download/v{HMCL_VERSION}/{jar.name}',
             jar, HMCL_SHA256, 'sha256')
    game = launcher / '.minecraft' if mode == 'demo' else launcher / 'instances' / instance
    for folder in ('libraries', 'assets'):
        source = RUNTIME / 'client' / folder
        for file in source.rglob('*'):
            if file.is_file():
                link_file(file, game / folder / file.relative_to(source))
    version = game / 'versions' / instance
    metadata = json.loads((RUNTIME / (VERSION + '.json')).read_text(encoding='utf-8'))
    metadata['id'] = instance
    if mode == 'demo':
        metadata['arguments']['game'] = [a for a in metadata['arguments']['game']
                                        if not (isinstance(a, dict) and '--demo' in str(a.get('value', '')))] + ['--demo']
    else:
        metadata['arguments']['game'] += ['--quickPlayMultiplayer', '127.0.0.1:25565']
    save(version / (instance + '.json'), metadata)
    link_file(RUNTIME / 'client' / 'client.jar', version / (instance + '.jar'))
    write_once(game / 'options.txt', 'lang:zh_cn\nrenderDistance:6\nsimulationDistance:5\nfullscreen:false\nmaxFps:60\n')
    settings = launcher / '.hmcl' / 'config'
    # These files belong to this isolated lab launcher, not a user's global installation.
    directories_file = settings / 'game-directories.json'
    directories = json.loads(directories_file.read_text(encoding='utf-8')) if directories_file.exists() else {
        '$schema': 'https://schemas.glavo.site/hmcl/game-directories/1.0.0', 'directories': []}
    directories['directories'] = [d for d in directories['directories'] if d['id'] != directory_id] + [{'id': directory_id, 'path': str(game)}]
    save(directories_file, directories)
    accounts_file = settings / 'accounts.json'
    accounts = json.loads(accounts_file.read_text(encoding='utf-8')) if accounts_file.exists() else {
        '$schema': 'https://schemas.glavo.site/hmcl/accounts/1.0.0', 'accounts': []}
    accounts['accounts'] = [a for a in accounts['accounts'] if a['accountID'] != account_id] + [{
        'accountID': account_id, 'type': 'offline', 'profileName': player,
        'profileID': str(uuid.uuid5(uuid.NAMESPACE_DNS, 'anima-' + player))}]
    save(accounts_file, accounts)
    save(settings / 'game-settings.json', {
        '$schema': 'https://schemas.glavo.site/hmcl/game-settings/1.0.0',
        'presets': [{'id': PRESET_ID, 'autoNameNumber': 1, 'javaType': 'CUSTOM',
                     'customJavaPath': config['java'], 'autoMemory': False, 'maxMemory': 2048,
                     'width': 1280, 'height': 720, 'gameArguments': ''}]})
    previous = settings / 'launcher-settings.json'
    current = json.loads(previous.read_text(encoding='utf-8')) if previous.exists() else {
        '$schema': 'https://schemas.glavo.site/hmcl/launcher-settings/1.0.0'}
    selected = current.get('selectedInstance', {})
    selected[directory_id] = instance
    current.update({'selectedGameDirectory': directory_id, 'selectedInstance': selected,
                    'defaultGameSettingsPreset': PRESET_ID, 'selectedAccount': account_id})
    save(previous, current)
    save(RUNTIME / 'launcher.json', {'java': config['java'], 'jar': str(jar), 'directory': str(launcher),
                                    'instance': instance, 'sha256': HMCL_SHA256, 'demo': mode == 'demo', 'mode': mode})
    print('HMCL instance ready: ' + instance, flush=True)


def launch(mode=None):
    path = RUNTIME / 'launcher.json'
    if not path.exists():
        prepare(mode or 'demo')
    c = json.loads(path.read_text(encoding='utf-8'))
    if mode and c.get('mode', 'demo') != mode:
        prepare(mode)
        c = json.loads(path.read_text(encoding='utf-8'))
    log = (RUNTIME / 'launcher' / 'stdout.log').open('a', encoding='utf-8')
    process = subprocess.Popen([c['java'], '-jar', c['jar']], cwd=c['directory'],
                               stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    print(f'HMCL starting (PID {process.pid}). Instance: {c["instance"]}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--mode', choices=['demo', 'normal'])
    args = parser.parse_args()
    if args.prepare:
        prepare(args.mode or 'demo')
    else:
        launch(args.mode)
