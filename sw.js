/* Cache public shell and public landscape photos only. Never cache GitHub API responses. */
'use strict';
const VERSION='1.2.0';
const ROOT=new URL('./',self.location.href);
const PREFIX='travel-handbook:'+ROOT.pathname+':';
const CACHE=PREFIX+VERSION;
const PHOTOS='travel-handbook:landmark-photos:v1';
const FILES=['./','index.html','app.css','core.js','photos.js','photo-manifest.json','app.js','manifest.webmanifest','icons/icon.svg','icons/icon-192.png','icons/icon-512.png'];
const URLS=FILES.map(p=>new URL(p,ROOT).href);
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(URLS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(PREFIX)&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.hostname==='api.github.com')return;
 const remotePhoto=['upload.wikimedia.org','thumb.wikimedia.org'].includes(url.hostname)&&url.protocol==='https:';
 const localPhoto=url.origin===ROOT.origin&&url.pathname.startsWith(new URL('photos/',ROOT).pathname)&&/\.(jpe?g|png|webp)$/i.test(url.pathname);
 if((remotePhoto||localPhoto)&&request.destination==='image'){
  event.respondWith((async()=>{const cache=await caches.open(PHOTOS),hit=await cache.match(request);if(hit)return hit;const r=await fetch(request);if(r.ok||(remotePhoto&&r.type==='opaque'))await cache.put(request,r.clone());return r;})());return;
 }
 if(url.origin!==ROOT.origin||!URLS.includes(url.href))return;
 if(request.mode==='navigate')event.respondWith((async()=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),4000);try{const response=await fetch(request,{signal:controller.signal});if(response.ok){const cache=await caches.open(CACHE);await cache.put(request,response.clone());}return response;}catch(_){return await caches.match(request)||await caches.match(new URL('index.html',ROOT).href)||Response.error();}finally{clearTimeout(timer);}})());
 else event.respondWith(caches.match(request).then(cached=>cached||fetch(request)));
});
