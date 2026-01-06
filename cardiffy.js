(function () {
    'use strict';

    /**
     * Cardify Free Plugin
     * @version 1.4.1
     * 
     * Changelog:
     * 1.4.1 - Исправлен размер логотипа, реакции, детали
     * 1.4.0 - iTunes трейлеры
     */
    var PLUGIN_VERSION = '1.4.1';

    var DEBUG = true;
    
    function log() {
        if (DEBUG) {
            var args = Array.prototype.slice.call(arguments);
            args.unshift('[Cardify v' + PLUGIN_VERSION + ']');
            console.log.apply(console, args);
        }
    }

    log('Загрузка плагина...');

    // ==================== МОДУЛЬ ITUNES ТРЕЙЛЕРОВ ====================
    var iTunesTrailer = (function() {
        
        function searchItunes(query, mediaType, callback) {
            var url = 'https://itunes.apple.com/search' +
                '?term=' + encodeURIComponent(query).replace(/%20/g, '+') +
                '&media=' + mediaType +
                '&limit=10';
            
            log('iTunes запрос:', url);
            
            $.ajax({
                url: url,
                dataType: 'json',
                timeout: 10000,
                success: function(data) {
                    log('iTunes ответ:', data);
                    if (data && data.results && data.results.length) {
                        callback(data.results);
                    } else {
                        callback(null);
                    }
                },
                error: function(xhr, status, error) {
                    log('iTunes ошибка:', status, error);
                    callback(null);
                }
            });
        }
        
        function load(movie, isTv, callback) {
            var title = movie.original_title || movie.original_name || movie.title || movie.name || '';
            
            if (!title || !/[a-z]{2}/i.test(title)) {
                log('iTunes: нет подходящего названия');
                callback(null);
                return;
            }
            
            var year = (movie.release_date || movie.first_air_date || '').substring(0, 4);
            var mediaType = isTv ? 'tvShow' : 'movie';
            
            log('iTunes поиск:', title, 'год:', year, 'тип:', mediaType);
            
            // Проверяем кэш
            var cacheKey = 'cardify_itunes_' + movie.id;
            var cached = sessionStorage.getItem(cacheKey);
            if (cached) {
                var cachedData = JSON.parse(cached);
                if (cachedData.url) {
                    log('iTunes из кэша:', cachedData.url);
                    callback(cachedData);
                } else {
                    callback(null);
                }
                return;
            }
            
            searchItunes(title, mediaType, function(results) {
                if (!results) {
                    sessionStorage.setItem(cacheKey, JSON.stringify({ url: null }));
                    callback(null);
                    return;
                }
                
                // Ищем подходящий результат
                var found = null;
                for (var i = 0; i < results.length; i++) {
                    var r = results[i];
                    if (!r.previewUrl) continue;
                    
                    // Проверяем год если есть
                    if (year && r.releaseDate) {
                        var resultYear = r.releaseDate.substring(0, 4);
                        if (resultYear !== year) continue;
                    }
                    
                    found = r;
                    break;
                }
                
                if (found && found.previewUrl) {
                    var video = {
                        title: found.trackName || found.collectionName || title,
                        url: found.previewUrl
                    };
                    log('iTunes найден:', video.url);
                    sessionStorage.setItem(cacheKey, JSON.stringify(video));
                    callback(video);
                } else {
                    log('iTunes: подходящий трейлер не найден');
                    sessionStorage.setItem(cacheKey, JSON.stringify({ url: null }));
                    callback(null);
                }
            });
        }
        
        return { load: load };
    })();

    // ==================== МОДУЛЬ ОРИГИНАЛЬНОГО НАЗВАНИЯ ====================
    var OriginalTitle = (function() {
        var storageKey = "cardify_title_cache";
        var CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
        var titleCache = Lampa.Storage.get(storageKey) || {};

        async function fetchTitles(card) {
            var orig = card.original_title || card.original_name || '';
            var ru, en, translit;

            var now = Date.now();
            var cache = titleCache[card.id];
            
            if (cache && now - cache.timestamp < CACHE_TTL) {
                return {
                    original: orig,
                    ru: cache.ru,
                    en: cache.en,
                    translit: cache.translit
                };
            }

            try {
                var type = card.first_air_date ? "tv" : "movie";
                var data = await new Promise(function(res, rej) {
                    Lampa.Api.sources.tmdb.get(
                        type + "/" + card.id + "?append_to_response=translations",
                        {}, res, rej
                    );
                });
                
                var tr = data.translations?.translations || [];

                var ruData = tr.find(function(t) { 
                    return t.iso_3166_1 === "RU" || t.iso_639_1 === "ru"; 
                });
                ru = ruData?.data?.title || ruData?.data?.name;
                
                var enData = tr.find(function(t) { 
                    return t.iso_3166_1 === "US" || t.iso_639_1 === "en"; 
                });
                en = enData?.data?.title || enData?.data?.name;

                titleCache[card.id] = { ru: ru, en: en, translit: translit, timestamp: now };
                Lampa.Storage.set(storageKey, titleCache);
            } catch (e) {
                log('Ошибка загрузки переводов:', e);
            }

            return { original: orig, ru: ru, en: en, translit: translit };
        }

        function render(container, titles) {
            container.find('.cardify-original-titles').remove();
            
            var lang = Lampa.Storage.get("language") || 'ru';
            var items = [];
            
            if (titles.original) {
                items.push({ title: titles.original, label: 'Original' });
            }
            
            if (titles.en && lang !== 'en' && titles.en !== titles.original) {
                items.push({ title: titles.en, label: 'EN' });
            }
            
            if (titles.ru && lang !== 'ru' && titles.ru !== titles.original) {
                items.push({ title: titles.ru, label: 'RU' });
            }

            if (items.length === 0) return;

            var html = '<div class="cardify-original-titles">';
            items.forEach(function(item) {
                html += '<div class="cardify-original-titles__item">';
                html += '<span class="cardify-original-titles__text">' + item.title + '</span>';
                html += '<span class="cardify-original-titles__label">' + item.label + '</span>';
                html += '</div>';
            });
            html += '</div>';

            var buttons = container.find('.full-start-new__buttons');
            if (buttons.length) {
                buttons.before(html);
            }
        }

        return { fetch: fetchTitles, render: render };
    })();

    // ==================== STATE ====================
    function State(object) {
        this.state = object.state;
        this.start = function () { this.dispath(this.state); };
        this.dispath = function (name) {
            var action = object.transitions[name];
            if (action) action.call(this, this);
        };
    }

    // ==================== PLAYER ====================
    var Player = function(object, video) {
        var self = this;
        
        this.paused = false;
        this.display = false;
        this.loaded = false;
        this.destroyed = false;
        this.timer = null;
        this.listener = Lampa.Subscribe();
        this.video = video;
        
        log('Player создан:', video.url);
        
        this.html = $('\
            <div class="cardify-trailer">\
                <div class="cardify-trailer__player">\
                    <video class="cardify-trailer__video" playsinline muted></video>\
                    <div class="cardify-trailer__loading">\
                        <div class="cardify-trailer__spinner"></div>\
                        <div class="cardify-trailer__status">Загрузка трейлера...</div>\
                    </div>\
                </div>\
                <div class="cardify-trailer__controlls">\
                    <div class="cardify-trailer__title">' + (video.title || 'Трейлер') + '</div>\
                    <div class="cardify-trailer__remote">\
                        <div class="cardify-trailer__remote-icon">\
                            <svg width="37" height="37" viewBox="0 0 37 37" fill="none">\
                                <circle cx="18.5" cy="18.5" r="7" fill="white"/>\
                                <path d="M32.5 7.2L26.8 12.9C27.85 14.5 28.5 16.4 28.5 18.5C28.5 20.9 27.6 23.1 26.2 24.8L31.9 30.5C34.7 27.3 36.5 23.1 36.5 18.5C36.5 14.2 35 10.3 32.5 7.2Z" fill="white" fill-opacity="0.3"/>\
                            </svg>\
                        </div>\
                        <div class="cardify-trailer__remote-text">' + Lampa.Lang.translate('cardify_enable_sound') + '</div>\
                    </div>\
                </div>\
            </div>\
        ');

        this.videoElement = this.html.find('.cardify-trailer__video')[0];
        this.loadingElement = this.html.find('.cardify-trailer__loading');

        this.initVideo = function() {
            if (self.destroyed) return;
            
            log('Загружаем видео:', video.url);
            
            self.videoElement.src = video.url;
            self.videoElement.muted = true;
            
            $(self.videoElement).one('canplay loadeddata', function() {
                if (self.destroyed) return;
                log('Видео готово к воспроизведению');
                self.loadingElement.hide();
                self.loaded = true;
                self.listener.send('loaded');
            });
            
            $(self.videoElement).one('error', function(e) {
                if (self.destroyed) return;
                log('Ошибка загрузки видео:', e);
                self.listener.send('error');
            });
            
            self.videoElement.load();
        };

        $(this.videoElement).on('playing', function() {
            if (self.destroyed) return;
            self.paused = false;
            
            clearInterval(self.timer);
            self.timer = setInterval(function() {
                if (!self.videoElement.duration || self.destroyed) return;
                
                var left = self.videoElement.duration - self.videoElement.currentTime;
                
                if (left <= 8) {
                    if (!self.videoElement.muted) {
                        self.videoElement.volume = Math.max(0, left / 8);
                    }
                    if (left <= 3) {
                        clearInterval(self.timer);
                        self.listener.send('ended');
                    }
                }
            }, 200);

            self.listener.send('play');
            if (window.cardify_fist_unmute) self.unmute();
        });

        $(this.videoElement).on('pause', function() {
            if (self.destroyed) return;
            self.paused = true;
            clearInterval(self.timer);
        });

        $(this.videoElement).on('ended', function() {
            if (self.destroyed) return;
            self.listener.send('ended');
        });

        setTimeout(function() { self.initVideo(); }, 100);

        this.play = function() {
            if (this.destroyed) return;
            try { 
                var p = this.videoElement.play();
                if (p) p.catch(function(e) { log('Autoplay blocked'); });
            } catch (e) {}
        };

        this.pause = function() {
            try { this.videoElement.pause(); } catch (e) {}
        };

        this.unmute = function() {
            this.videoElement.muted = false;
            this.videoElement.volume = 1;
            this.html.find('.cardify-trailer__remote').remove();
            window.cardify_fist_unmute = true;
        };

        this.show = function() {
            this.html.addClass('display');
            this.display = true;
        };

        this.hide = function() {
            this.html.removeClass('display');
            this.display = false;
        };

        this.render = function() { return this.html; };

        this.destroy = function() {
            this.destroyed = true;
            clearInterval(this.timer);
            try { 
                this.videoElement.pause();
                this.videoElement.src = '';
            } catch (e) {}
            this.html.remove();
        };
    };

    // ==================== TRAILER ====================
    var Trailer = function(object, video) {
        var self = this;
        
        object.activity.trailer_ready = true;
        this.object = object;
        this.video = video;
        this.player = null;
        this.destroyed = false;
        this.background = object.activity.render().find('.full-start__background');
        this.startblock = object.activity.render().find('.cardify');
        this.head = $('.head');
        this.timelauch = 2000;

        this.state = new State({
            state: 'start',
            transitions: {
                start: function(state) {
                    if (self.destroyed) return;
                    clearTimeout(self.timer_load);
                    if (self.player.display) {
                        state.dispath('play');
                    } else if (self.player.loaded) {
                        self.animate();
                        self.timer_load = setTimeout(function() {
                            if (!self.destroyed) state.dispath('load');
                        }, self.timelauch);
                    }
                },
                load: function(state) {
                    if (self.destroyed) return;
                    if (self.player.loaded && Lampa.Controller.enabled().name == 'full_start' && self.same()) {
                        state.dispath('play');
                    }
                },
                play: function() {
                    if (self.destroyed) return;
                    self.player.play();
                },
                toggle: function(state) {
                    if (self.destroyed) return;
                    clearTimeout(self.timer_load);
                    if (Lampa.Controller.enabled().name == 'cardify_trailer') {
                    } else if (Lampa.Controller.enabled().name == 'full_start' && self.same() && self.player.loaded) {
                        state.start();
                    } else if (self.player.display) {
                        state.dispath('hide');
                    }
                },
                hide: function() {
                    if (self.destroyed) return;
                    self.player.pause();
                    self.player.hide();
                    self.background.removeClass('nodisplay');
                    self.startblock.removeClass('nodisplay');
                    self.head.removeClass('nodisplay');
                    self.object.activity.render().find('.cardify-preview__loader').width(0);
                }
            }
        });

        this.same = function() {
            return Lampa.Activity.active().activity === this.object.activity;
        };

        this.animate = function() {
            var loader = this.object.activity.render().find('.cardify-preview__loader').width(0);
            var started = Date.now();
            clearInterval(this.timer_anim);
            this.timer_anim = setInterval(function() {
                if (self.destroyed) { clearInterval(self.timer_anim); return; }
                var elapsed = Date.now() - started;
                if (elapsed > self.timelauch) clearInterval(self.timer_anim);
                loader.width(Math.round(elapsed / self.timelauch * 100) + '%');
            }, 50);
        };

        this.preview = function() {
            if (this.destroyed) return;
            var img = object.activity.render().find('.full--poster').attr('src') || '';
            var preview = $('<div class="cardify-preview"><div><img class="cardify-preview__img" src="' + img + '" /><div class="cardify-preview__loader"></div><div class="cardify-preview__icon"><svg viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg></div></div></div>');
            object.activity.render().find('.cardify__right').prepend(preview);
        };

        this.controll = function() {
            if (this.destroyed) return;
            var out = function() {
                self.state.dispath('hide');
                Lampa.Controller.toggle('full_start');
            };
            Lampa.Controller.add('cardify_trailer', {
                toggle: function() { Lampa.Controller.clear(); },
                enter: function() { self.player.unmute(); },
                left: out, up: out, down: out, right: out,
                back: function() {
                    self.player.destroy();
                    self.object.activity.render().find('.cardify-preview').remove();
                    out();
                }
            });
            Lampa.Controller.toggle('cardify_trailer');
        };

        this.start = function() {
            var toggle = function() { if (!self.destroyed) self.state.dispath('toggle'); };
            var destroy = function(e) {
                if (e.type == 'destroy' && e.object.activity === self.object.activity) remove();
            };
            var remove = function() {
                Lampa.Listener.remove('activity', destroy);
                Lampa.Controller.listener.remove('toggle', toggle);
                self.destroy();
            };
            Lampa.Listener.follow('activity', destroy);
            Lampa.Controller.listener.follow('toggle', toggle);

            this.player = new Player(object, video);

            this.player.listener.follow('loaded', function() {
                if (self.destroyed) return;
                log('Трейлер загружен');
                self.preview();
                self.state.start();
            });

            this.player.listener.follow('play', function() {
                if (self.destroyed) return;
                clearTimeout(self.timer_show);
                self.timer_show = setTimeout(function() {
                    if (self.destroyed) return;
                    self.player.show();
                    self.background.addClass('nodisplay');
                    self.startblock.addClass('nodisplay');
                    self.head.addClass('nodisplay');
                    self.controll();
                }, 300);
            });

            this.player.listener.follow('ended,error', function() {
                if (self.destroyed) return;
                log('Трейлер завершён или ошибка');
                self.state.dispath('hide');
                if (Lampa.Controller.enabled().name == 'cardify_trailer') {
                    Lampa.Controller.toggle('full_start');
                }
                self.object.activity.render().find('.cardify-preview').remove();
                setTimeout(remove, 300);
            });

            object.activity.render().find('.activity__body').prepend(this.player.render());
        };

        this.destroy = function() {
            this.destroyed = true;
            clearTimeout(this.timer_load);
            clearTimeout(this.timer_show);
            clearInterval(this.timer_anim);
            if (this.player) this.player.destroy();
        };

        this.start();
    };

    // ==================== PLUGIN START ====================
    function startPlugin() {
        log('Инициализация...');

        Lampa.Lang.add({
            cardify_enable_sound: {
                ru: 'Включить звук', en: 'Enable sound', uk: 'Увімкнути звук'
            },
            cardify_enable_trailer: {
                ru: 'Автовоспроизведение трейлера', en: 'Autoplay trailer', uk: 'Автовідтворення трейлера'
            },
            cardify_show_original_title: {
                ru: 'Показывать оригинальное название', en: 'Show original title', uk: 'Показувати оригінальну назву'
            }
        });

        // CSS
        var style = $('<style id="cardify-styles">\
            .cardify{transition:all .3s}\
            .cardify .full-start-new__body{height:80vh}\
            .cardify .full-start-new__right{display:flex;align-items:flex-end}\
            .cardify .full-start-new__head{margin-bottom:0.5em}\
            \
            /* ЛОГОТИП - уменьшенный */\
            .cardify .full-start-new__title{\
                font-size:3em !important;\
                line-height:1.15 !important;\
                text-shadow:0 2px 8px rgba(0,0,0,0.5);\
                margin-bottom:0.3em;\
            }\
            .cardify .full-start-new__title img,\
            .cardify .full-start-new__head img,\
            .cardify .full-start__title-img,\
            .cardify img.full--logo{\
                max-height:5em !important;\
                max-width:70% !important;\
                height:auto !important;\
                width:auto !important;\
            }\
            \
            /* ДЕТАЛИ (год, страна, жанры) */\
            .cardify .full-start-new__details{\
                margin-bottom:0.8em;\
                font-size:1.3em;\
                opacity:0.7;\
            }\
            \
            /* ОРИГИНАЛЬНЫЕ НАЗВАНИЯ */\
            .cardify-original-titles{\
                margin-bottom:1em;\
                display:flex;\
                flex-direction:column;\
                gap:0.2em;\
            }\
            .cardify-original-titles__item{\
                display:flex;\
                align-items:center;\
                gap:0.5em;\
                font-size:1.2em;\
                opacity:0.75;\
            }\
            .cardify-original-titles__label{\
                font-size:0.6em;\
                padding:0.15em 0.35em;\
                background:rgba(255,255,255,0.12);\
                border-radius:3px;\
                text-transform:uppercase;\
                opacity:0.6;\
            }\
            \
            /* LAYOUT */\
            .cardify__left{flex-grow:1;max-width:65%}\
            .cardify__right{display:flex;flex-direction:column;align-items:flex-end;flex-shrink:0}\
            \
            /* ОДНА РЕАКЦИЯ - правильное отображение */\
            .cardify .full-start-new__reactions{margin:0 0 1em 0}\
            .cardify .full-start-new__reactions:not(.focus){margin:0 0 1em 0}\
            .cardify .full-start-new__reactions:not(.focus)>div>*:not(:first-child){display:none}\
            .cardify .full-start-new__reactions .reaction{position:relative}\
            .cardify .full-start-new__reactions .reaction__count{\
                position:absolute;\
                top:50%;\
                left:100%;\
                transform:translateY(-50%);\
                margin-left:0.3em;\
                font-size:1.1em;\
                font-weight:500;\
                white-space:nowrap;\
            }\
            \
            .cardify .full-start-new__rate-line{margin:0}\
            \
            /* ФОН */\
            .cardify__background{left:0}\
            .cardify__background.nodisplay{opacity:0 !important}\
            .cardify.nodisplay{transform:translate3d(0,50%,0);opacity:0}\
            body:not(.menu--open) .cardify__background{mask-image:linear-gradient(to bottom,white 50%,rgba(255,255,255,0) 100%)}\
            \
            /* ТРЕЙЛЕР */\
            .cardify-trailer{opacity:0;transition:opacity .3s;position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:#000}\
            .cardify-trailer.display{opacity:1}\
            .cardify-trailer__player{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}\
            .cardify-trailer__video{width:100%;height:100%;object-fit:contain}\
            .cardify-trailer__loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:#fff}\
            .cardify-trailer__spinner{width:50px;height:50px;border:4px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:cardify-spin 1s linear infinite;margin:0 auto 1em}\
            @keyframes cardify-spin{to{transform:rotate(360deg)}}\
            .cardify-trailer__controlls{position:fixed;left:1.5em;right:1.5em;bottom:1.5em;display:flex;align-items:flex-end;transform:translateY(100%);opacity:0;transition:all .3s}\
            .cardify-trailer.display .cardify-trailer__controlls{transform:translateY(0);opacity:1}\
            .cardify-trailer__title{flex:1;font-size:2em;font-weight:600;color:#fff}\
            .cardify-trailer__remote{display:flex;align-items:center;color:#fff}\
            .cardify-trailer__remote-icon{width:2.5em;height:2.5em}\
            .cardify-trailer__remote-icon svg{width:100%;height:100%}\
            .cardify-trailer__remote-text{margin-left:0.8em;font-size:1.1em}\
            \
            /* ПРЕВЬЮ */\
            .cardify-preview{border-radius:0.4em;width:8em;height:5em;background:#000;overflow:hidden;margin-bottom:1em;position:relative}\
            .cardify-preview__img{width:100%;height:100%;object-fit:cover}\
            .cardify-preview__loader{position:absolute;left:0;bottom:0;height:3px;background:#fff;width:0}\
            .cardify-preview__icon{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:2em;height:2em;background:rgba(0,0,0,0.6);border-radius:50%;display:flex;align-items:center;justify-content:center}\
            .cardify-preview__icon svg{width:1em;height:1em}\
            \
            .head.nodisplay{transform:translateY(-100%)}\
            .cardify .original_title{display:none !important}\
        </style>');
        
        $('head').append(style);

        // Настройки
        Lampa.SettingsApi.addComponent({
            component: 'cardify',
            icon: '<svg width="36" height="28" viewBox="0 0 36 28" fill="none"><rect x="1.5" y="1.5" width="33" height="25" rx="3.5" stroke="white" stroke-width="3"/></svg>',
            name: 'Cardify v' + PLUGIN_VERSION
        });

        Lampa.SettingsApi.addParam({
            component: 'cardify',
            param: { name: 'cardify_run_trailers', type: 'trigger', default: true },
            field: { name: Lampa.Lang.translate('cardify_enable_trailer') }
        });

        Lampa.SettingsApi.addParam({
            component: 'cardify',
            param: { name: 'cardify_show_original_title', type: 'trigger', default: true },
            field: { name: Lampa.Lang.translate('cardify_show_original_title') }
        });

        // Слушатель
        Lampa.Listener.follow('full', function(e) {
            if (e.type == 'complite') {
                log('Full complite');
                
                var render = e.object.activity.render();
                render.find('.full-start__background').addClass('cardify__background');

                // Оригинальные названия
                if (Lampa.Storage.field('cardify_show_original_title') !== false && e.data.movie) {
                    OriginalTitle.fetch(e.data.movie).then(function(titles) {
                        OriginalTitle.render(render.find('.cardify__left'), titles);
                    });
                }

                // iTunes трейлеры
                if (Lampa.Storage.field('cardify_run_trailers') !== false && e.data.movie) {
                    var isTv = !!(e.object.method && e.object.method === 'tv');
                    
                    iTunesTrailer.load(e.data.movie, isTv, function(video) {
                        if (video && video.url && !e.object.activity.trailer_ready) {
                            log('Трейлер найден, запускаем');
                            
                            if (Lampa.Activity.active().activity === e.object.activity) {
                                new Trailer(e.object, video);
                            } else {
                                var follow = function(a) {
                                    if (a.type == 'start' && a.object.activity === e.object.activity && !e.object.activity.trailer_ready) {
                                        Lampa.Listener.remove('activity', follow);
                                        new Trailer(e.object, video);
                                    }
                                };
                                Lampa.Listener.follow('activity', follow);
                            }
                        }
                    });
                }
            }
        });

        log('Плагин инициализирован');
    }

    if (window.appready) startPlugin();
    else Lampa.Listener.follow('app', function(e) { if (e.type == 'ready') startPlugin(); });

})();
