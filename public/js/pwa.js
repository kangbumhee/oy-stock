var PWA = {
  deferredPrompt: null,
  installed: false,
  serviceWorkerReady: false,

  init: function () {
    this.installed =
      window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    this._bindInstallPrompt();
    this._registerServiceWorker();
    this._syncInstallButton();
  },

  _registerServiceWorker: function () {
    var self = this;
    if (!('serviceWorker' in navigator)) {
      this._syncInstallButton();
      return;
    }
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      this._syncInstallButton();
      return;
    }
    if (!this._controllerChangeBound) {
      this._controllerChangeBound = true;
      var refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });
    }
    navigator.serviceWorker
      .register('/sw.js?v=20260622-1')
      .then(function (registration) {
        if (registration && registration.update) {
          try {
            registration.update();
          } catch (e) {}
        }
        return navigator.serviceWorker.ready;
      })
      .then(function () {
        self.serviceWorkerReady = true;
        self._syncInstallButton();
      })
      .catch(function (e) {
        console.warn('service worker registration failed', e);
        self.serviceWorkerReady = false;
        self._syncInstallButton();
      });
  },

  _bindInstallPrompt: function () {
    var self = this;
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      self.deferredPrompt = e;
      self._syncInstallButton();
    });
    window.addEventListener('appinstalled', function () {
      self.installed = true;
      self.deferredPrompt = null;
      self._syncInstallButton();
      if (window.UI) UI.showSyncStatus('앱 설치가 완료됐습니다', false);
    });
    try {
      window.matchMedia('(display-mode: standalone)').addEventListener('change', function (e) {
        self.installed = !!e.matches;
        self._syncInstallButton();
      });
    } catch (e) {}
  },

  _syncInstallButton: function () {
    var btn = document.getElementById('install-app-btn');
    if (!btn) return;
    if (this.installed) {
      btn.textContent = '설치됨';
      btn.disabled = true;
      btn.classList.add('installed');
      btn.title = '이미 앱처럼 실행 중입니다';
      return;
    }
    btn.disabled = false;
    btn.classList.remove('installed');
    btn.textContent = this.deferredPrompt ? '설치' : '앱 설치';
    btn.title = this.deferredPrompt
      ? '올리브재고를 앱으로 설치'
      : '설치창이 안 뜨면 브라우저 메뉴의 앱 설치를 이용해 주세요';
  },

  install: function () {
    var self = this;
    if (this.installed) return;
    if (this.deferredPrompt) {
      var promptEvent = this.deferredPrompt;
      this.deferredPrompt = null;
      try {
        promptEvent.prompt();
      } catch (e) {
        this._showInstallGuide(true);
        this._syncInstallButton();
        return;
      }
      Promise.resolve(promptEvent.userChoice)
        .then(function (choice) {
          if (choice && choice.outcome === 'accepted') {
            self.installed = true;
          }
          self._syncInstallButton();
        })
        .catch(function () {
          self._syncInstallButton();
        });
      return;
    }
    this._showInstallGuide(!this.serviceWorkerReady);
  },

  _showInstallGuide: function (waitingForWorker) {
    var msg = this._installGuideMessage(waitingForWorker);
    if (window.UI) {
      UI.showSyncStatus(msg, false, 6500);
    } else {
      alert(msg);
    }
  },

  _installGuideMessage: function (waitingForWorker) {
    var ua = navigator.userAgent || '';
    var isIos = /iPhone|iPad|iPod/i.test(ua);
    var isAndroid = /Android/i.test(ua);
    if (waitingForWorker) {
      return '앱 설치 준비 중입니다. 새로고침 후 다시 누르거나 브라우저 메뉴의 앱 설치를 눌러 주세요.';
    }
    if (isIos) {
      return '아이폰은 공유 버튼을 누른 뒤 "홈 화면에 추가"로 설치해 주세요.';
    }
    if (isAndroid) {
      return 'Chrome 메뉴(⋮)에서 "앱 설치" 또는 "홈 화면에 추가"를 눌러 주세요.';
    }
    return '주소창 오른쪽 설치 아이콘이나 Chrome 메뉴의 "페이지를 앱으로 설치"를 눌러 주세요.';
  }
};
