/**
 * Lampa Ad Blocker v3
 * Блокирует рекламу на уровне логики, не по доменам
 */

(function() {
    'use strict';

    console.log('[AdBlocker] === ЗАГРУЖЕН v3 ===');

    function applyPatches() {
        if (!window.Lampa) return;

        // ============================================================
        // ГЛАВНЫЙ ПАТЧ: Подменяем данные о рекламе на пустые
        // ============================================================
        
        // Патч 1: Перехватываем Player.play
        if (Lampa.Player && Lampa.Player.play && !Lampa.Player._adblocked) {
            var originalPlay = Lampa.Player.play;
            
            Lampa.Player.play = function(element) {
                if (element) {
                    // Убиваем все рекламные поля
                    element.vast = null;
                    element.vast_url = null;
                    element.vast_msg = null;
                    element.vast_region = null;
                    element.vast_platform = null;
                    element.vast_screen = null;
                }
                console.log('[AdBlocker] ✅ Player.play без рекламы');
                return originalPlay.call(this, element);
            };
            
            Lampa.Player._adblocked = true;
        }

        // Патч 2: Очищаем список прероллов в Storage
        if (Lampa.Storage) {
            // Перехватываем получение рекламных данных
            var originalGet = Lampa.Storage.get;
            
            if (!Lampa.Storage._adblocked) {
                Lampa.Storage.get = function(name, defaultValue) {
                    // Если запрашивают рекламу — возвращаем пустоту
                    if (name && (
                        name.includes('vast') || 
                        name.includes('preroll') || 
                        name.includes('ad_')
                    )) {
                        console.log('[AdBlocker] 🚫 Storage.get blocked:', name);
                        return defaultValue || [];
                    }
                    return originalGet.apply(this, arguments);
                };
                
                Lampa.Storage._adblocked = true;
            }
        }

        // Патч 3: Перехватываем глобальный объект рекламы
        if (Lampa.Ad && !Lampa.Ad._adblocked) {
            // Сохраняем оригинал
            var OriginalAd = Lampa.Ad;
            
            // Заменяем на заглушку
            Lampa.Ad = function() {
                console.log('[AdBlocker] 🚫 new Lampa.Ad() → заглушка');
                
                return {
                    start: function(callback) {
                        console.log('[AdBlocker] ✅ Ad.start() → сразу callback');
                        if (callback) setTimeout(callback, 0);
                        return this;
                    },
                    destroy: function() { return this; },
                    launch: function(callback) {
                        if (callback) setTimeout(callback, 0);
                        return this;
                    },
                    ended: function() { return this; }
                };
            };
            
            // Копируем статические методы если есть
            for (var key in OriginalAd) {
                if (OriginalAd.hasOwnProperty(key)) {
                    Lampa.Ad[key] = function() {
                        console.log('[AdBlocker] 🚫 Lampa.Ad.' + key + '() blocked');
                        return null;
                    };
                }
            }
            
            Lampa.Ad._adblocked = true;
        }

        // Патч 4: Если есть отдельный Vast модуль
        if (Lampa.Vast && !Lampa.Vast._adblocked) {
            Lampa.Vast = function() {
                return {
                    load: function(callback) {
                        if (callback) setTimeout(function() { callback(null); }, 0);
                    },
                    show: function(callback) {
                        if (callback) setTimeout(callback, 0);
                    },
                    destroy: function() {}
                };
            };
            Lampa.Vast._adblocked = true;
        }

        console.log('[AdBlocker] ✅ Все патчи применены');
    }

    // ============================================================
    // ЗАПУСК В РАЗНЫЕ МОМЕНТЫ
    // ============================================================

    // Сразу
    applyPatches();

    // С задержками (на случай если Lampa загрузится позже)
    [0, 50, 100, 200, 500, 1000, 2000].forEach(function(delay) {
        setTimeout(applyPatches, delay);
    });

    // При загрузке DOM
    document.addEventListener('DOMContentLoaded', applyPatches);

    // При готовности Lampa
    var waitForLampa = setInterval(function() {
        if (window.Lampa) {
            applyPatches();
            
            if (Lampa.Listener) {
                Lampa.Listener.follow('app', function(e) {
                    if (e.type === 'ready') {
                        applyPatches();
                    }
                });
                clearInterval(waitForLampa);
            }
        }
    }, 50);

    // Остановить проверку через 10 сек
    setTimeout(function() {
        clearInterval(waitForLampa);
    }, 10000);

})();
