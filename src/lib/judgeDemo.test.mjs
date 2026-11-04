import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Creative Studio upload and camera are separate workflows with a real camera',()=>{
 const page=fs.readFileSync(new URL('../pages/CreativeStudioPage.tsx',import.meta.url),'utf8');
 const camera=fs.readFileSync(new URL('../components/ScannerCamera.tsx',import.meta.url),'utf8');
 assert.match(page,/Upload Image/);
 assert.match(page,/Take Photo/);
 assert.match(page,/ScannerCamera/);
 // The upload picker must not be relabelled as the camera.
 const uploadInput=page.slice(page.indexOf('id="studio-photo-input"')-200,page.indexOf('id="studio-photo-input"')+300);
 assert.equal(uploadInput.includes('capture='),false);
 // Take Photo opens the real getUserMedia camera, with denial handling.
 assert.match(camera,/getUserMedia/);
 assert.match(camera,/NotAllowedError/);
 assert.match(camera,/Camera permission was denied/);
});

test('Scanner UI is Live AI primary with no mock selection or token field',()=>{
 const page=fs.readFileSync(new URL('../pages/ScannerPage.tsx',import.meta.url),'utf8');
 assert.match(page,/Live AI Scan/);
 assert.equal(page.includes('scanner-live-token'),false);
 assert.equal(page.includes('Mock scan (default)'),false);
 assert.equal(page.includes('liveTestToken'),false);
});

test('No user-facing source requires a 64-character live test token',()=>{
 for(const rel of ['../pages/CreativeStudioPage.tsx','../pages/ScannerPage.tsx','../pages/SettingsPage.tsx','../components/BuckyPanel.tsx','../components/ProductPhotoReview.tsx']){
   const text=fs.readFileSync(new URL(rel,import.meta.url),'utf8');
   assert.equal(text.includes('LIVE_TEST_TOKEN'),false,rel);
   assert.equal(text.includes('liveTestToken'),false,rel);
   assert.equal(text.includes('Live test token'),false,rel);
 }
});
