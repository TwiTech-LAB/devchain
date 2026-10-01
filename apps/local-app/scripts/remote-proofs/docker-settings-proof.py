#!/usr/bin/env python3
"""Source-only create-from-inspect probes; does not imply cross-version compatibility."""
import json
import subprocess
import tempfile
import pathlib
import sys
import shlex

prefix = 'dc-settings-ffe78fcf'
label = 'devchain.proof=ffe78fcf'
root = pathlib.Path(tempfile.mkdtemp(prefix=prefix))
containers = []
target = sys.argv[1] if len(sys.argv)>1 else None
network = prefix + '-net'
volume = prefix + '-data'


def command(*args, data=None, check=True):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)


def docker(*args):
    return command('sudo', '-n', 'docker', *args).stdout.decode().strip()


def create(name, *args):
    containers.append(name)
    docker('create', '--name', name, '--label', label, *args)
    return json.loads(docker('inspect', name))[0]


def destination(*args, data=None, check=True):
    if target:
        return command('ssh','-i','/home/ngsupb/.ssh/id_ed25519','-o','IdentitiesOnly=yes','-o','BatchMode=yes',target,shlex.join(args),data=data,check=check)
    return command(*args,data=data,check=check)


def destdocker(*args):
    return destination('sudo','-n','docker',*args).stdout.decode().strip()


def api_create(name, payload):
    containers.append(name)
    return destination('sudo', '-n', 'curl', '--fail-with-body', '-sS', '--unix-socket', '/var/run/docker.sock', '-H', 'Content-Type: application/json', '--data-binary', '@-', 'http://localhost/v1.55/containers/create?name=' + name, data=json.dumps(payload).encode())


def emit(case, **values):
    print(json.dumps({'case': case, **values}), flush=True)


try:
    docker('network', 'create', '--label', label, network)
    docker('volume', 'create', '--label', label, volume)
    if target:
        destdocker('network','create','--label',label,network)
        destdocker('volume','create','--label',label,volume)
        destination('mkdir','-p',str(root))
    saved = create(prefix + '-original', '--network', network, '--network-alias', 'proof-alias', '--user', '1234:2345', '--restart', 'unless-stopped', '-p', '127.0.0.1::8080', '-v', volume + ':/data', '-v', str(root) + ':/bind', 'alpine:3.22', 'sleep', '300')
    config = saved['Config'].copy()
    config['Image'] = saved['Image']
    host = {key: saved['HostConfig'][key] for key in ['Binds', 'PortBindings', 'RestartPolicy', 'NetworkMode']}
    payload = {**config, 'HostConfig': host, 'NetworkingConfig': {'EndpointsConfig': {network: {'Aliases': ['proof-alias']}}}}
    api_create(prefix + '-clone', payload)
    clone = json.loads(destdocker('inspect', prefix + '-clone'))[0]
    emit('saved-settings-import', stopped=clone['State']['Status']=='created', user=clone['Config']['User'], restart=clone['HostConfig']['RestartPolicy']['Name'], mountTypes=sorted(m['Type'] for m in clone['Mounts']), network=clone['HostConfig']['NetworkMode'], aliases=clone['NetworkSettings']['Networks'][network]['Aliases'], ports=clone['HostConfig']['PortBindings'])
    destdocker('start', prefix + '-clone')
    emit('saved-settings-start', running=json.loads(destdocker('inspect', prefix + '-clone'))[0]['State']['Running'])
    for setting, args in [('device', ['--device', '/dev/null:/dev/proof']), ('docker-socket', ['-v', '/var/run/docker.sock:/var/run/docker.sock']), ('host-network', ['--network', 'host'])]:
        original = create(prefix + '-' + setting, *args, 'alpine:3.22', 'sleep', '300')
        stripped = prefix + '-' + setting + '-stripped'
        api_create(stripped, {**original['Config'], 'Image': original['Image'], 'HostConfig': {'NetworkMode': 'bridge'}})
        destdocker('start', stripped)
        result = json.loads(destdocker('inspect', stripped))[0]
        emit('dropped-' + setting, running=result['State']['Running'], devices=result['HostConfig']['Devices'], binds=result['HostConfig']['Binds'], network=result['HostConfig']['NetworkMode'])
finally:
    for name in reversed(containers):
        command('sudo','-n','docker','rm','-f',name,check=False)
    command('sudo','-n','docker','volume','rm',volume,check=False)
    command('sudo','-n','docker','network','rm',network,check=False)
    if target:
        for name in reversed(containers): destination('sudo','-n','docker','rm','-f',name,check=False)
        destination('sudo','-n','docker','volume','rm',volume,check=False)
        destination('sudo','-n','docker','network','rm',network,check=False)
        destination('rmdir',str(root),check=False)
    root.rmdir()
    emit('cleanup', containers=docker('ps','-aq','--filter','label='+label), volumes=docker('volume','ls','-q','--filter','label='+label), networks=docker('network','ls','-q','--filter','label='+label))
