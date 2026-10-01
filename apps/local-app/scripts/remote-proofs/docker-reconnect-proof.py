#!/usr/bin/env python3
"""Disposable reconnect replacement and cancellation mechanics on the source engine."""
import json
import pathlib
import subprocess
import tempfile

prefix = 'dc-reconnect-ffe78fcf'
label = 'devchain.proof=ffe78fcf'
root = pathlib.Path(tempfile.mkdtemp(prefix=prefix))
volume = prefix + '-data'
conflict = prefix + '-unlabelled'
helper = prefix + '-helper'
config = root / 'compose.json'


def command(*args, check=True):
    return subprocess.run(['sudo','-n','docker',*args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check)


def docker(*args):
    return command(*args).stdout.decode().strip()


def emit(case, **values):
    print(json.dumps({'case':case, **values}), flush=True)


try:
    docker('volume','create','--label',label,volume)
    config.write_text(json.dumps({'name':prefix,'services':{'hold':{'image':'alpine:3.22','command':['sleep','300'],'volumes':['data:/data']}},'volumes':{'data':{'external':True,'name':volume}}}))
    compose = ['compose','-f',str(config)]
    docker(*compose,'up','-d')
    holder = prefix + '-hold-1'
    docker('exec',holder,'sh','-c','echo kept > /data/home; echo stale > /data/vm-only')
    before = json.loads(docker('inspect',holder))[0]
    refused = command('volume','rm',volume,check=False)
    emit('compose-created-holder', composeProject=before['Config']['Labels']['com.docker.compose.project'], devchainLabel=before['Config']['Labels'].get('devchain.proof'), removeVolumeBlocked=refused.returncode!=0)
    docker(*compose,'down')
    docker('volume','rm',volume)
    docker('volume','create','--label',label,volume)
    docker('run','--rm','--label',label,'-v',volume+':/data','alpine:3.22','sh','-c','echo fresh > /data/home; test ! -e /data/vm-only')
    docker(*compose,'up','-d')
    after = json.loads(docker('inspect',holder))[0]
    emit('second-connect-replacement', replacedHolder=before['Id']!=after['Id'], freshData=docker('exec',holder,'cat','/data/home')=='fresh', staleGone=command('exec',holder,'test','!','-e','/data/vm-only',check=False).returncode==0)
    docker(*compose,'down')
    docker('volume','rm',volume)
    docker('volume','create','--label',label,volume)
    docker('create','--name',helper,'--label',label,'-v',volume+':/data','alpine:3.22','true')
    docker('rm',helper)
    docker('volume','rm',volume)
    emit('cancel-during-replacement', attemptHelperGone=command('inspect',helper,check=False).returncode!=0, attemptVolumeGone=command('volume','inspect',volume,check=False).returncode!=0, oldVmCopyRecoverable=False)
    docker('volume','create',conflict)
    labels = json.loads(docker('volume','inspect',conflict))[0]['Labels'] or {}
    emit('unlabelled-name-conflict', action='reject-before-delete', hasOwnershipLabel=labels.get('devchain.proof')=='ffe78fcf', volumeStillExists=command('volume','inspect',conflict,check=False).returncode==0)
finally:
    if config.exists(): command('compose','-f',str(config),'down',check=False)
    command('rm','-f',helper,check=False)
    for name in [volume,conflict]: command('volume','rm',name,check=False)
    config.unlink(missing_ok=True)
    root.rmdir()
    emit('cleanup', containers=docker('ps','-aq','--filter','name='+prefix), volumes=docker('volume','ls','-q','--filter','name='+prefix), networks=docker('network','ls','-q','--filter','name='+prefix))
