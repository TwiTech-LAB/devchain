#!/usr/bin/env python3
"""Disposable source-engine archive and lifecycle probes; invoke as the normal user."""
import io
import json
import pathlib
import subprocess
import tarfile
import tempfile

PREFIX = 'dc-proof-ffe78fcf'
LABEL = 'devchain.proof=ffe78fcf'
IMAGE = 'alpine:3.22'
root = pathlib.Path(tempfile.mkdtemp(prefix=PREFIX + '-'))
containers = []
volumes = []


def run(*args, data=None, check=True):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)


def docker(*args):
    return run('sudo', '-n', 'docker', *args).stdout.decode().strip()


def api(method, path, data=None):
    args = ['sudo', '-n', 'curl', '--fail-with-body', '-sS', '--unix-socket', '/var/run/docker.sock', '-X', method]
    if data is not None:
        args += ['-H', 'Content-Type: application/x-tar', '--data-binary', '@-']
    return run(*args, 'http://localhost/v1.55' + path, data=data).stdout


def container(name, *args):
    name = PREFIX + '-' + name
    before=set(docker('volume','ls','-q').splitlines())
    docker('create', '--name', name, '--label', LABEL, *args)
    containers.append(name)
    mounts=[m['Name'] for m in json.loads(docker('inspect',name))[0]['Mounts'] if m['Type']=='volume']
    owned=[v for v in mounts if v not in before]
    volumes.extend(v for v in owned if v not in volumes)
    emit('container-mount-inventory', container=name, newlyCreatedVolumes=owned, protectedExistingVolumes=[v for v in mounts if v in before])
    return name


def volume(name):
    name = PREFIX + '-' + name
    volumes.append(name)
    docker('volume', 'create', '--label', LABEL, name)
    return name


def emit(case, **values):
    print(json.dumps({'case': case, **values}), flush=True)


try:
    version = json.loads(api('GET', '/version'))
    emit('versions', engine=version['Version'], api=version['ApiVersion'], minimum=version['MinAPIVersion'], compose=docker('compose', 'version', '--short'))
    source, target = volume('source'), volume('target')
    bind = root / 'root-owned'
    bind.mkdir()
    seed = container('seed', '-v', source + ':/data', '-v', str(bind) + ':/bind', IMAGE, 'sh', '-c', 'for d in /data /bind; do mkdir -p "$d/nested"; printf proof > "$d/nested/file"; chown 1234:2345 "$d/nested/file"; chmod 640 "$d/nested/file"; ln -s nested/file "$d/link"; chown 0:0 "$d"; chmod 700 "$d"; done')
    docker('start', '-a', seed)
    reader = container('reader', '-v', source + ':/data', '-v', str(bind) + ':/bind', IMAGE, 'true')
    destbind = root / 'missing' / 'data'
    writer = container('writer', '-v', target + ':/data', '-v', str(destbind) + ':/bind', IMAGE, 'true')
    emit('helper-create-missing-bind', parentExists=destbind.parent.exists(), dataExists=destbind.exists(), running=json.loads(docker('inspect', writer))[0]['State']['Running'])
    for mount in ['data', 'bind']:
        archive = api('GET', '/containers/' + reader + '/archive?path=/' + mount)
        members = tarfile.open(fileobj=io.BytesIO(archive)).getmembers()
        before = [(x.name, x.uid, x.gid, x.mode, x.linkname) for x in members]
        api('PUT', '/containers/' + writer + '/archive?copyUIDGID=true&path=/', archive)
        after_archive = api('GET', '/containers/' + writer + '/archive?path=/' + mount)
        after = [(x.name, x.uid, x.gid, x.mode, x.linkname) for x in tarfile.open(fileobj=io.BytesIO(after_archive)).getmembers()]
        emit('archive-' + mount, sourceMetadata=before, restoredMetadata=after, bytes=len(archive), equal=before == after, helpersNeverStarted=all(json.loads(docker('inspect', c))[0]['State']['Status'] == 'created' for c in [reader, writer]))
    size = docker('run', '--rm', '--label', LABEL, '-v', str(bind) + ':/data:ro', IMAGE, 'du', '-sb', '/data')
    emit('sizing-service-image', result=size)
    emit('helper-after-archive-bind', parentExists=destbind.parent.exists(), dataExists=destbind.exists(), parentUid=destbind.parent.stat().st_uid, dataUid=destbind.stat().st_uid)
    auto = container('auto', '--rm', '-v', '/data', IMAGE, 'sh', '-c', 'echo auto > /data/file; sleep 300')
    docker('start', auto)
    anon = json.loads(docker('inspect', auto))[0]['Mounts'][0]['Name']
    hold = container('hold', '-v', anon + ':/data', IMAGE, 'true')
    docker('stop', auto)
    kept = run('sudo', '-n', 'docker', 'volume', 'inspect', anon, check=False).returncode == 0
    emit('running-auto-remove', originalAutoRemove=True, originalVolumeTarget='/data', holderAutoRemove=False, originalRemoved=run('sudo','-n','docker','inspect',auto,check=False).returncode != 0, heldBeforeStop=True, volumeSurvived=kept, dataReadable=b'auto' in api('GET', '/containers/' + hold + '/archive?path=/data/.'))
    docker('rm', hold)
    survives_helper_removal = run('sudo','-n','docker','volume','inspect',anon,check=False).returncode == 0
    again = container('hold-again', '-v', anon + ':/data', IMAGE, 'true')
    emit('explicit-existing-anonymous-cleanup', survivesLastHolderRemoval=survives_helper_removal, dataPreserved=b'auto' in api('GET', '/containers/' + again + '/archive?path=/data/.'))
    volumes.append(anon)
    shared = container('unselected', '-v', source + ':/data', IMAGE, 'true')
    removal = run('sudo', '-n', 'docker', 'volume', 'rm', source, check=False)
    emit('shared-volume', removalRejected=removal.returncode != 0, holders=[reader, seed, shared])
    overlap = container('overlap', '-v', str(root) + ':/project', '-v', str(bind) + ':/nested', IMAGE, 'true')
    mounted = json.loads(docker('inspect', overlap))[0]['Mounts']
    emit('overlapping-binds', sources=[m['Source'] for m in mounted], duplicateSubtree=str(bind).startswith(str(root) + '/'), policy='collapse parent-child archive coverage; preserve both mount targets')
    info = json.loads(api('GET', '/info'))
    emit('storage', dockerRoot=info['DockerRootDir'], driver=info['Driver'], driverStatus=info['DriverStatus'], paths=run('sudo','-n','du','-s','/var/lib/docker','/var/lib/containerd',str(root)).stdout.decode().splitlines())
finally:
    for name in reversed(containers):
        run('sudo', '-n', 'docker', 'rm', '-f', name, check=False)
    for name in volumes:
        run('sudo', '-n', 'docker', 'volume', 'rm', name, check=False)
    run('sudo', '-n', 'rm', '-rf', '--', str(root))
    emit('cleanup', remainingContainers=docker('ps','-aq','--filter','label='+LABEL), remainingVolumes=docker('volume','ls','-q','--filter','label='+LABEL))
