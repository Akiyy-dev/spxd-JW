import assert from 'node:assert/strict';
import test from 'node:test';
import {avatarFileKind, avatarCrop, maxAvatarBytes} from '../src/avatar-image.ts';

test('avatars accept JPEG, PNG, WebP and GIF, and reject unsupported or mismatched types and oversize originals', () => {
  assert.equal(avatarFileKind({name:'photo.JPG',type:'image/jpeg',size:1}), 'static');
  assert.equal(avatarFileKind({name:'photo.png',type:'image/png',size:maxAvatarBytes}), 'static');
  assert.equal(avatarFileKind({name:'photo.webp',type:'image/webp',size:100}), 'static');
  assert.equal(avatarFileKind({name:'animation.gif',type:'image/gif',size:100}), 'gif');
  assert.equal(avatarFileKind({name:'animation.GIF',type:'',size:100}), 'gif');
  for (const file of [
    {name:'photo.svg',type:'image/svg+xml',size:100},
    {name:'photo.jpg',type:'image/svg+xml',size:100},
    {name:'photo.gif',type:'image/gif',size:0},
    {name:'photo.png',type:'image/png',size:maxAvatarBytes+1},
  ]) assert.throws(() => avatarFileKind(file));
});

test('square avatar crops include the chosen area of landscape and portrait photos', () => {
  assert.deepEqual(avatarCrop(1800,1200), {x:300,y:0,size:1200});
  assert.deepEqual(avatarCrop(1200,1800), {x:0,y:300,size:1200});
  assert.deepEqual(avatarCrop(1800,1200,1,0,0), {x:0,y:0,size:1200});
  assert.deepEqual(avatarCrop(1800,1200,1,1,1), {x:600,y:0,size:1200});
  assert.deepEqual(avatarCrop(1800,1200,2,1,1), {x:1200,y:600,size:600});
  for (const [width,height] of [[1,1],[40,4000],[4000,40],[2800,4200]]) {
    const crop=avatarCrop(width,height,3,0.25,0.75);
    assert.ok(crop.x>=0 && crop.y>=0 && crop.size>0);
    assert.ok(crop.x+crop.size<=width && crop.y+crop.size<=height);
  }
});

test('invalid dimensions and crop positions fail before canvas allocation', () => {
  for (const dimensions of [[0,10],[-1,10],[NaN,20],[Infinity,20],[10000,10000]]) {
    assert.throws(() => avatarCrop(dimensions[0],dimensions[1]));
  }
  assert.throws(() => avatarCrop(200,200,0));
  assert.throws(() => avatarCrop(200,200,1,-1,0));
});
