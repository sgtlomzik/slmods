/**
 * Lampa Ad Blocker - TEST VERSION
 */

(function() {
    'use strict';

    console.log('[AdBlocker] === СКРИПТ ЗАГРУЖЕН ===');

    // Блокируем сетевые запросы
    var originalXHR = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (typeof url === 'string') {
            if (url.includes('betweendigital') ||
                url.includes('yandex.ru/ads') ||
                url.includes('adfox')) {
                console.log('[AdBlocker] ❌ BLOCKED:', url.substring(0, 80));
                this._blocked = true;
            }
        }
        return originalXHR.apply(this, arguments);
    };

    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function() {
        if (this._blocked) {
            console.log('[AdBlocker] ❌ SEND BLOCKED');
            // Имитируем ошибку
            var self = this;
            setTimeout(function() {
                if (self.onerror) self.onerror(new Error('Blocked'));
            }, 10);
            return;
        }
        return originalSend.apply(this, arguments);
    };

    function hookPlayer() {
        if (!Lampa || !Lampa.Player || !Lampa.Player.play) {
            console.log('[AdBlocker] ⚠️ Lampa.Player не найден');
            return false;
        }

        if (Lampa.Player._adblock_hooked) {
            console.log('[AdBlocker] ⚠️ Уже подключен');
            return true;
        }

        var originalPlay = Lampa.Player.play;

        Lampa.Player.play = function(element) {
            console.log('[AdBlocker] 🎬 Player.play вызван');
            console.log('[AdBlocker] vast_url:', element ? element.vast_url : 'нет element');
            
            if (element) {
                if (element.vast_url) {
                    console.log('[AdBlocker] ✅ Удаляю vast_url');
                    delete element.vast_url;
                }
                delete element.vast_msg;
                delete element.vast_region;
                delete element.vast_platform;
                delete element.vast_screen;
            }

            return originalPlay.call(this, element);
        };

        Lampa.Player._adblock_hooked = true;
        console.log('[AdBlocker] ✅ Player.play перехвачен');
        return true;
    }

    function init() {
        console.log('[AdBlocker] init(), window.Lampa =', !!window.Lampa);
        
        if (window.Lampa) {
            hookPlayer();
            
            // Следим за рекламой
            if (Lampa.Listener) {
                Lampa.Listener.follow('full', function(e) {
                    console.log('[AdBlocker] EVENT full:', e.type);
                });
                
                Lampa.Listener.follow('app', function(e) {
                    console.log('[AdBlocker] EVENT app:', e.type);
                    if (e.type === 'ready') {
                        hookPlayer();
                    }
                });
            }
        }
    }

    // Запуск сразу
    init();

    // И с задержкой
    setTimeout(init, 500);
    setTimeout(init, 1000);
    setTimeout(init, 2000);

    // При загрузке DOM
    document.addEventListener('DOMContentLoaded', init);

})();
