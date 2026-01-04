/**
 * Lampa Ad Blocker v2
 * Полностью убирает рекламный блок
 */

(function() {
    'use strict';

    console.log('[AdBlocker] === ЗАГРУЖЕН v2 ===');

    // ================================================================
    // СПОСОБ 1: Мгновенный провал XHR запросов к рекламе
    // ================================================================
    
    var originalXHROpen = XMLHttpRequest.prototype.open;
    var originalXHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        if (typeof url === 'string' && isAdUrl(url)) {
            console.log('[AdBlocker] ❌ BLOCKED:', url.substring(0, 60));
            this._blocked = true;
        }
        return originalXHROpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function() {
        if (this._blocked) {
            var self = this;
            // Мгновенно вызываем ошибку, не ждём таймаут
            setTimeout(function() {
                self.status = 0;
                self.readyState = 4;
                if (self.onerror) self.onerror(new Error('Blocked by AdBlocker'));
                if (self.onloadend) self.onloadend();
                if (self.onreadystatechange) self.onreadystatechange();
            }, 1);
            return;
        }
        return originalXHRSend.apply(this, arguments);
    };

    function isAdUrl(url) {
        return url.includes('betweendigital') ||
               url.includes('yandex.ru/ads') ||
               url.includes('adfox') ||
               url.includes('/vast') ||
               url.includes('vast.') ||
               url.includes('ads.');
    }

    // ================================================================
    // СПОСОБ 2: Перехват рекламного модуля Lampa
    // ================================================================

    function patchAdModule() {
        if (!window.Lampa) return;

        // Патчим функцию показа рекламы
        if (Lampa.Ad && !Lampa.Ad._patched) {
            var originalAd = Lampa.Ad;
            
            Lampa.Ad = function(params) {
                console.log('[AdBlocker] 🚫 Ad конструктор перехвачен');
                
                return {
                    start: function() {
                        console.log('[AdBlocker] 🚫 Ad.start() → пропуск');
                        if (params && params.onComplete) params.onComplete();
                        return this;
                    },
                    destroy: function() {},
                    launch: function() {
                        console.log('[AdBlocker] 🚫 Ad.launch() → пропуск');
                        if (params && params.onComplete) params.onComplete();
                    }
                };
            };
            
            Lampa.Ad._patched = true;
            console.log('[AdBlocker] ✅ Lampa.Ad пропатчен');
        }

        // Очищаем список рекламы в хранилище
        if (Lampa.Storage) {
            var adKeys = ['vast_list', 'ad_list', 'preroll', 'vast_prerolls'];
            adKeys.forEach(function(key) {
                try {
                    Lampa.Storage.set(key, []);
                    Lampa.Storage.set(key, null);
                } catch(e) {}
            });
        }
    }

    // ================================================================
    // СПОСОБ 3: Перехват Player.play - убираем рекламные данные
    // ================================================================

    function patchPlayer() {
        if (!Lampa || !Lampa.Player) return;
        if (Lampa.Player._adblock_patched) return;

        var originalPlay = Lampa.Player.play;

        Lampa.Player.play = function(element) {
            console.log('[AdBlocker] 🎬 Player.play');
            
            if (element) {
                // Удаляем ВСЕ рекламные поля
                delete element.vast;
                delete element.vast_url;
                delete element.vast_msg;
                delete element.vast_region;
                delete element.vast_platform;
                delete element.vast_screen;
                delete element.preroll;
                delete element.advert;
                delete element.ad;
                
                // Явно говорим что рекламы нет
                element.noAd = true;
            }

            return originalPlay.call(this, element);
        };

        Lampa.Player._adblock_patched = true;
        console.log('[AdBlocker] ✅ Player.play пропатчен');
    }

    // ================================================================
    // СПОСОБ 4: Перехват события показа рекламы
    // ================================================================

    function patchListener() {
        if (!Lampa || !Lampa.Listener) return;
        if (Lampa.Listener._adblock_patched) return;

        var originalFollow = Lampa.Listener.follow;

        Lampa.Listener.follow = function(name, callback) {
            if (name === 'ad' || name === 'vast' || name === 'preroll') {
                console.log('[AdBlocker] 🚫 Listener для', name, 'заблокирован');
                return;
            }
            return originalFollow.apply(this, arguments);
        };

        Lampa.Listener._adblock_patched = true;
    }

    // ================================================================
    // СПОСОБ 5: Подмена функции показа рекламного блока
    // ================================================================

    function patchAdShow() {
        // Ищем и патчим функции связанные с рекламой
        if (window.Lampa) {
            // Пробуем найти Ad модуль через разные пути
            var paths = ['Lampa.Ad', 'Lampa.Ads', 'Lampa.Vast', 'Lampa.Preroll'];
            
            paths.forEach(function(path) {
                try {
                    var obj = eval(path);
                    if (obj && obj.show) {
                        var original = obj.show;
                        obj.show = function() {
                            console.log('[AdBlocker] 🚫', path, '.show() заблокирован');
                            return Promise.resolve();
                        };
                    }
                    if (obj && obj.launch) {
                        obj.launch = function() {
                            console.log('[AdBlocker] 🚫', path, '.launch() заблокирован');
                        };
                    }
                } catch(e) {}
            });
        }
    }

    // ================================================================
    // ЗАПУСК
    // ================================================================

    function applyAllPatches() {
        console.log('[AdBlocker] Применяю патчи...');
        patchAdModule();
        patchPlayer();
        patchListener();
        patchAdShow();
    }

    // Запуск сразу
    if (window.Lampa) {
        applyAllPatches();
    }

    // И с задержками
    setTimeout(applyAllPatches, 0);
    setTimeout(applyAllPatches, 100);
    setTimeout(applyAllPatches, 500);
    setTimeout(applyAllPatches, 1000);

    // При готовности приложения
    document.addEventListener('DOMContentLoaded', applyAllPatches);

    if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function(e) {
            if (e.type === 'ready') {
                applyAllPatches();
            }
        });
    }

    // Отслеживаем создание Lampa
    var checkLampa = setInterval(function() {
        if (window.Lampa) {
            applyAllPatches();
            clearInterval(checkLampa);
        }
    }, 50);

    setTimeout(function() {
        clearInterval(checkLampa);
    }, 10000);

})();
