function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function proxyArchivePath(path) {
  return '/api/archive-file?path=' + encodeURIComponent(path);
}

function bridgeScript() {
  var script = String.raw`(function(){
    function meta(d){var k=d.key||" ";var c=d.code||"";var n=d.keyCode||d.which||0;return {key:k,code:c,keyCode:n,which:n};}
    function ev(t,m){var e=new KeyboardEvent(t,{key:m.key,code:m.code,bubbles:true,cancelable:true,composed:true});try{Object.defineProperty(e,"keyCode",{get:function(){return m.keyCode;}});Object.defineProperty(e,"which",{get:function(){return m.which;}});}catch(x){}return e;}
    window.__oliveAudioContexts=window.__oliveAudioContexts||[];
    window.__oliveNativeAudioContext=window.__oliveNativeAudioContext||window.AudioContext||window.webkitAudioContext;
    function remember(ctx){try{if(ctx&&window.__oliveAudioContexts.indexOf(ctx)<0)window.__oliveAudioContexts.push(ctx);}catch(x){}return ctx;}
    function primeAudioContext(){
      try{
        var NativeAC=window.__oliveNativeAudioContext;
        if(!NativeAC)return null;
        var ctx=window.__olivePrimedAudioContext;
        if(!ctx||ctx.state==="closed"){ctx=remember(new NativeAC());window.__olivePrimedAudioContext=ctx;}
        try{ctx.resume&&ctx.resume().catch(function(){});}catch(x){}
        try{
          var gain=ctx.createGain();gain.gain.value=0.00001;gain.connect(ctx.destination);
          var osc=ctx.createOscillator();osc.connect(gain);osc.start(0);osc.stop(ctx.currentTime+0.06);
        }catch(x){}
        return ctx;
      }catch(x){return null;}
    }
    (function(){
      try{
        var NativeAC=window.__oliveNativeAudioContext;
        if(!NativeAC||NativeAC.__oliveWrapped)return;
        function WrappedAC(){
          var primed=window.__olivePrimedAudioContext;
          if(primed&&primed.state!=="closed")return remember(primed);
          return remember(new NativeAC());
        }
        WrappedAC.prototype=NativeAC.prototype;
        try{Object.setPrototypeOf(WrappedAC,NativeAC);}catch(x){}
        WrappedAC.__oliveWrapped=true;
        if(window.AudioContext)window.AudioContext=WrappedAC;
        if(window.webkitAudioContext)window.webkitAudioContext=WrappedAC;
      }catch(x){}
    })();
    function resumeAudioContexts(){
      try{
        var list=(window.__oliveAudioContexts||[]).slice();
        var ac=(window.Module&&Module.SDL2&&Module.SDL2.audioContext)||(window.JSMESS&&JSMESS.audioContext)||(window.JSMESS&&JSMESS.audio&&JSMESS.audio.context);
        if(ac&&list.indexOf(ac)<0)list.push(ac);
        for(var i=0;i<list.length;i++){if(list[i]&&list[i].state==="suspended"&&list[i].resume)list[i].resume().catch(function(){});}
        if(window.Module){Module.noAudioDecoding=false;Module.audioContext=Module.audioContext||ac||window.__olivePrimedAudioContext;}
      }catch(x){}
    }
    function forceMameAudio(){
      try{
        if(window.jsmame_web_audio){
          try{if(window.jsmame_web_audio.set_mastervolume)window.jsmame_web_audio.set_mastervolume(0);}catch(x){}
          try{var ctx=window.jsmame_web_audio.get_context&&window.jsmame_web_audio.get_context();if(ctx&&ctx.state==="suspended"&&ctx.resume)ctx.resume().catch(function(){});}catch(x){}
        }
      }catch(x){}
      try{
        if(window.JSMESS){
          var sound=window.JSMESS.get_sound&&window.JSMESS.get_sound();
          try{if(window.JSMESS.sdl_pauseaudio)window.JSMESS.sdl_pauseaudio(0);}catch(x){}
          try{if(sound&&window.JSMESS.sound_manager_mute)window.JSMESS.sound_manager_mute(sound,0,0);}catch(x){}
          try{if(sound&&window.JSMESS.sound_manager_mute)window.JSMESS.sound_manager_mute(sound,false,false);}catch(x){}
        }
      }catch(x){}
      try{
        var M=window.Module;
        if(M){
          M.noAudioDecoding=false;
          try{if(M._SDL_PauseAudio)M._SDL_PauseAudio(0);}catch(x){}
          try{var msound=M.__ZN15running_machine20emscripten_get_soundEv&&M.__ZN15running_machine20emscripten_get_soundEv();if(msound&&M.__ZN13sound_manager4muteEbh)M.__ZN13sound_manager4muteEbh(msound,0,0);}catch(x){}
          try{if(M.audioContext&&M.audioContext.state==="suspended"&&M.audioContext.resume)M.audioContext.resume().catch(function(){});}catch(x){}
        }
      }catch(x){}
    }
    function unmuteEmulatorCore(){
      try{
        var M=window.Module;
        if(!M)return;
        try{if(M.audioContext&&M.audioContext.resume)M.audioContext.resume().catch(function(){});}catch(x){}
        try{if(M._SDL_PauseAudio)M._SDL_PauseAudio(0);}catch(x){}
        try{
          if(M.__ZN15running_machine20emscripten_get_soundEv&&M.__ZN13sound_manager4muteEbh){
            var sound=M.__ZN15running_machine20emscripten_get_soundEv();
            if(sound)M.__ZN13sound_manager4muteEbh(sound,0,0);
          }
        }catch(x){}
        try{if(M.resumeMainLoop)M.resumeMainLoop();}catch(x){}
      }catch(x){}
      forceMameAudio();
    }
    function fixLocalAnchors(){
      try{
        var base=location.origin+location.pathname+location.search;
        document.querySelectorAll('a[href^="#"]').forEach(function(a){
          var hash=a.getAttribute("href")||"#";
          a.setAttribute("href",base+hash);
        });
        if(window.__oliveAnchorGuard)return;
        window.__oliveAnchorGuard=true;
        document.addEventListener("click",function(e){
          var t=e.target;
          var a=t&&t.closest?t.closest('a[href*="#"]'):null;
          if(!a)return;
          var raw=a.getAttribute("href")||"";
          var hash=raw.indexOf("#")>=0?raw.slice(raw.indexOf("#")):"";
          e.preventDefault();
          try{if(hash)history.replaceState(null,"",location.pathname+location.search+hash);}catch(x){}
        },true);
      }catch(x){}
    }
    function emulatorReady(){
      try{
        var canvas=document.getElementById("canvas");
        return !!(window.JSMESS||window.Module||(canvas&&(canvas.width>320||canvas.height>200))||document.querySelector(".emularity-running,.emulator-running,.js-emulation-loaded"));
      }catch(x){return false;}
    }
    function startEmulator(){
      try{
        fixLocalAnchors();
        var start=document.getElementById("jsmessSS")||document.querySelector(".js-emulation-emulate");
        var visible=start&&start.offsetParent!==null&&getComputedStyle(start).display!=="none"&&getComputedStyle(start).visibility!=="hidden";
        var now=Date.now();
        if(visible&&!emulatorReady()&&!window.__oliveClickingStart&&now-(window.__oliveLastStartClick||0)>800){
          window.__oliveLastStartClick=now;
          window.__oliveStartClicks=(window.__oliveStartClicks||0)+1;
          window.__oliveClickingStart=true;
          try{start.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true,view:window}));}catch(y){}
          try{start.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,cancelable:true,view:window}));}catch(y){}
          try{start.click();}catch(y){}
          window.__oliveClickingStart=false;
        }
        window.__oliveStartClicked=emulatorReady();
      }catch(x){}
    }
    function unmuteControls(){
      try{
        var nodes=Array.prototype.slice.call(document.querySelectorAll("*"));
        for(var i=0;i<nodes.length;i++){
          var el=nodes[i];var s=((el.getAttribute("aria-label")||"")+" "+(el.getAttribute("title")||"")+" "+(el.getAttribute("data-original-title")||"")+" "+(el.id||"")+" "+(el.className||"")+" "+(el.textContent||"")).toLowerCase();
          if(/unmute|muted|volume[-_ ]?(mute|off|none|0)|sound off|audio off|speaker[-_ ]?off|iconochive-volume-mute|js-mute/.test(s)&&!/fullscreen|share|favorite/.test(s)){
            try{el.__oliveSoundClicked=(el.__oliveSoundClicked||0)+1;if(el.__oliveSoundClicked<5)el.click();}catch(y){}
          }
        }
      }catch(x){}
      try{document.querySelectorAll("input[type=range],input[type=volume]").forEach(function(inp){inp.value=inp.max||1;inp.dispatchEvent(new Event("input",{bubbles:true}));inp.dispatchEvent(new Event("change",{bubbles:true}));});}catch(x){}
    }
    function unlockAudio(){
      window.__oliveAudioUnlockedAt=Date.now();
      primeAudioContext();
      startEmulator();
      resumeAudioContexts();
      forceMameAudio();
      try{document.querySelectorAll("audio,video").forEach(function(a){a.muted=false;a.defaultMuted=false;a.volume=1;try{a.removeAttribute("muted");}catch(y){}var p=a.play&&a.play();if(p&&p.catch)p.catch(function(){});});}catch(x){}
      unmuteControls();
      unmuteEmulatorCore();
      forceMameAudio();
      resumeAudioContexts();
      try{var cn=document.getElementById("canvas");if(cn){cn.setAttribute("tabindex","0");cn.focus();}}catch(x){}
    }
    function fire(t,d){unlockAudio();var m=meta(d);var nodes=[window,document,document.getElementById("canvas")].filter(Boolean);for(var i=0;i<nodes.length;i++){try{nodes[i].dispatchEvent(ev(t,m));}catch(x){}}try{var cn=document.getElementById("canvas");if(cn){cn.setAttribute("tabindex","0");cn.focus();}}catch(x){}}
    function burst(){if(window.__oliveClickingStart)return;unlockAudio();clearInterval(window.__oliveAudioPulse);var end=Date.now()+30000;window.__oliveAudioPulse=setInterval(function(){unlockAudio();forceMameAudio();if(Date.now()>end)clearInterval(window.__oliveAudioPulse);},220);}
    window.__oliveBridgeReady=true;window.__oliveTouchFire=fire;window.__oliveUnlockAudio=burst;
    window.addEventListener("message",function(e){var d=e.data||{};if(d.source!=="olivestock-touchpad")return;var t=d.type||d.event;if(t==="unlock-audio"){burst();return;}if(t==="keydown"||t==="keyup")fire(t,d);});
    ["pointerdown","touchstart","mousedown","click","keydown"].forEach(function(t){document.addEventListener(t,burst,{capture:true,passive:true});});
    document.addEventListener("DOMContentLoaded",function(){fixLocalAnchors();try{var cn=document.getElementById("canvas");if(cn){cn.setAttribute("tabindex","0");}}catch(x){}setTimeout(unlockAudio,300);});
  })();`;
  return '<script>' + script + '</script>';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.end('Method not allowed');
    return;
  }

  try {
    var id = (req.query && req.query.id) || '';
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(id)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><body>Invalid archive identifier</body>');
      return;
    }

    var response = await fetch('https://archive.org/embed/' + encodeURIComponent(id), {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'OliveStockArcade/1.0'
      },
      redirect: 'follow'
    });
    var html = await response.text();

    html = html.replace(/<head([^>]*)>/i, '<head$1><base href="https://archive.org/">');
    html = html.replace(/"url":"(\/(?:stream|download)\/[^"]+)"/g, function (_, p) {
      return '"url":"' + proxyArchivePath(p) + '"';
    });
    html = html.replace(/"screenshot":"(\/serve\/[^"]+)"/g, function (_, p) {
      return '"screenshot":"https://archive.org' + p + '"';
    });
    if (/<body([^>]*)>/i.test(html)) {
      html = html.replace(/<body([^>]*)>/i, '<body$1>' + bridgeScript());
    } else if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, bridgeScript() + '</body>');
    } else {
      html += bridgeScript();
    }

    res.statusCode = response.ok ? 200 : response.status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
    res.end(html);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><meta charset="utf-8"><body><h1>Archive embed load failed</h1><p>' + escapeHtml(err.message || err) + '</p></body>');
  }
};
