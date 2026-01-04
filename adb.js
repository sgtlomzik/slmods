/**
 * Lampa Ad Blocker v4
 * Исправлены ложные срабатывания + блокировка UI рекламы
 */

(function() {
    'use strict';

    // === НАСТРОЙКИ ===
    var DEBUG = false; // Поставь true для отладки
    
    function log() {
        if (DEBUG) console.log.apply(console, ['[AdBlocker]'].concat(Array.prototype.slice.call(arguments)));
    }

    // ============================================================
    // CSS: Скрываем надпись "РЕКЛАМА" и оверлеи
    // ============================================================
    function injectCSS() {
        if (document.getElementById('adblocker-css')) return;
        
        var style = document.createElement('style');
        style.id = 'adblocker-css';
        style.textContent = `
            /* Скрываем все элементы рекламного UI */
            .ad-notify,
            .player-video__ad,
            .player__advert,
            .player-video__advert,
            .vast-block,
            .preroll-notify,
            [class*="ad-overlay"],
            [class*="vast-"],
            [class*="preroll"] {
                display: none !important;
                visibility: hidden !important;
                opacity: 0 !important;
                pointer-events: none !important;
            }
        `;
        
        document.head.appendChild(style);
        log('✅ CSS injected');
    }

    // ============================================================
    // MutationObserver: Удаляем рекламные элементы динамически
    // ============================================================
    function setupObserver() {
        if (window._adObserver) return;
        
        window._adObserver = new MutationObserver(function(mutations) {
            mutations.forEach(function(m) {
                m.addedNodes.forEach(function(node) {
                    if (node.nodeType === 1) { // Element
                        var cl = node.className || '';
                        if (typeof cl === 'string' && (
                            cl.indexOf('ad-notify') !== -1 ||
                            cl.indexOf('vast') !== -1 ||
                            cl.indexOf('preroll') !== -1 ||
                            cl.indexOf('advert') !== -1
                        )) {
                            node.remove();
                            log('🗑️ Removed ad element:', cl);
                        }
                    }
                });
            });
        });
        
        window._adObserver.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    // ============================================================
    // ПАТЧИ
    // ============================================================
    function applyPatches() {
        if (!window.Lampa) return;

        injectCSS();
        if (document.body) setupObserver();

        // ----------------------------------------------------------
        // Патч 1: Storage.get — ТОЧНАЯ проверка ключей (не includes!)
        // ----------------------------------------------------------
        if (Lampa.Storage && !Lampa.Storage._adblocked) {
            var originalGet = Lampa.Storage.get;
            
            Lampa.Storage.get = function(name, defaultValue) {
                if (name && typeof name === 'string') {
                    // Только точные рекламные ключи
                    var isAdKey = /^(vast|preroll|ad_|ads$|advert)/.test(name) ||
                                  name.indexOf('vast_') === 0;
                    
                    if (isAdKey) {
                        log('🚫 Storage.get blocked:', name);
                        return defaultValue !== undefined ? defaultValue : null;
                    }
                }
                return originalGet.apply(this, arguments);
            };
            
            Lampa.Storage._adblocked = true;
        }

        // ----------------------------------------------------------
        // Патч 2: Player.play
        // ----------------------------------------------------------
        if (Lampa.Player && Lampa.Player.play && !Lampa.Player._adblocked) {
            var originalPlay = Lampa.Player.play;
            
            Lampa.Player.play = function(element) {
                if (element) {
                    delete element.vast;
                    delete element.vast_url;
                    delete element.vast_msg;
                    delete element.preroll;
                    delete element.advert;
                }
                log('✅ Player.play clean');
                return originalPlay.call(this, element);
            };
            
            Lampa.Player._adblocked = true;
        }

        // ----------------------------------------------------------
        // Патч 3: Перехват Listener событий рекламы
        // ----------------------------------------------------------
        if (Lampa.Listener && !Lampa.Listener._adSend) {
            var originalSend = Lampa.Listener.send;
            
            Lampa.Listener.send = function(type, data) {
                // Блокируем отправку рекламных событий
                if (type && typeof type === 'string') {
                    if (type.indexOf('ad') === 0 || type === 'vast' || type === 'preroll') {
                        log('🚫 Listener.send blocked:', type);
                        return;
                    }
                }
                return originalSend.apply(this, arguments);
            };
            
            Lampa.Listener._adSend = true;
        }

        // ----------------------------------------------------------
        // Патч 4: Блокируем создание Ad/Vast модулей
        // ----------------------------------------------------------
        ['Ad', 'Vast', 'Preroll', 'Advert'].forEach(function(name) {
            if (Lampa[name] && !Lampa[name]._blocked) {
                Lampa[name] = function() {
                    log('🚫 new Lampa.' + name + '() blocked');
                    return {
                        start: function(cb) { cb && setTimeout(cb, 0); return this; },
                        launch: function(cb) { cb && setTimeout(cb, 0); return this; },
                        show: function(cb) { cb && setTimeout(cb, 0); return this; },
                        run: function(cb) { cb && setTimeout(cb, 0); return this; },
                        destroy: function() { return this; },
                        ended: function() { return this; },
                        load: function(cb) { cb && setTimeout(function(){ cb(null); }, 0); return this; }
                    };
                };
                Lampa[name]._blocked = true;
            }
        });

        // ----------------------------------------------------------
        // Патч 5: Перехват fetch/XHR для блокировки VAST запросов
        // ----------------------------------------------------------
        if (!window._fetchAdBlocked && window.fetch) {
            var originalFetch = window.fetch;
            
            window.fetch = function(url, options) {
                if (url && typeof url === 'string') {
                    if (/ads\.|\/vast|betweendigital|adfox|yandex.*\/ads/i.test(url)) {
                        log('🚫 fetch blocked:', url.substring(0, 60));
                        return Promise.resolve(new Response('', { status: 200 }));
                    }
                }
                return originalFetch.apply(this, arguments);
            };
            
            window._fetchAdBlocked = true;
        }

        if (!window._xhrAdBlocked) {
            var originalOpen = XMLHttpRequest.prototype.open;
            var originalSend = XMLHttpRequest.prototype.send;
            
            XMLHttpRequest.prototype.open = function(method, url) {
                this._url = url;
                return originalOpen.apply(this, arguments);
            };
            
            XMLHttpRequest.prototype.send = function() {
                if (this._url && typeof this._url === 'string') {
                    if (/ads\.|\/vast|betweendigital|adfox|yandex.*\/ads/i.test(this._url)) {
                        log('🚫 XHR blocked:', this._url.substring(0, 60));
                        
                        // Имитируем ошибку чтобы Ad модуль быстро перешёл к следующему
                        var self = this;
                        setTimeout(function() {
                            if (self.onerror) self.onerror(new Error('blocked'));
                            if (self.onloadend) self.onloadend();
                        }, 0);
                        return;
                    }
                }
                return originalSend.apply(this, arguments);
            };
            
            window._xhrAdBlocked = true;
        }

        log('✅ Patches applied');
    }

    // ============================================================
    // ЗАПУСК
    // ============================================================
    
    // Сразу
    applyPatches();
    injectCSS();

    // DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            applyPatches();
            setupObserver();
        });
    } else {
        setupObserver();
    }

    // Ждём Lampa
    var attempts = 0;
    var waitInterval = setInterval(function() {
        attempts++;
        
        if (window.Lampa) {
            applyPatches();
            
            if (Lampa.Listener && !Lampa.Listener._adAppReady) {
                Lampa.Listener.follow('app', function(e) {
                    if (e.type === 'ready') applyPatches();
                });
                Lampa.Listener._adAppReady = true;
            }
        }
        
        // Останавливаемся после успеха или таймаута
        if (attempts > 50 || (Lampa && Lampa.Storage && Lampa.Storage._adblocked)) {
            clearInterval(waitInterval);
            log('✅ Init complete, attempts:', attempts);
        }
    }, 100);

})();
