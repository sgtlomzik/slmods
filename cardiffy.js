(function () {
    'use strict';

    /**
     * Cardify Free Plugin
     * @version 1.4.0
     * @date 2025-01-XX
     * 
     * Changelog:
     * 1.4.0 - iTunes трейлеры вместо YouTube, 3 реакции, исправлен размер логотипа
     * 1.3.0 - Интегрирован плагин оригинального названия
     * 1.2.0 - Исправлена блокировка интерфейса
     * 1.1.0 - Заменён YouTube на Invidious прокси
     * 1.0.0 - Первая версия без проверки премиума
     */
    var PLUGIN_VERSION = '1.4.0';

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
        
        function cacheRequest(search, movie, isTv, success, fail) {
            var url = 'https://itunes.apple.com/search' +
                '?term=' + encodeURIComponent(search).replace(/%20/g, '+') +
                '&media=' + (isTv ? 'tvShow' : 'movie') +
                '&lang=' + (Lampa.Storage.field('language') || 'en');
            
            var id = (isTv ? 'tv' : '') + (movie.id || (Lampa.Utils.hash(search) * 1).toString(36));
            var key = 'cardify_itunes_' + id;
            var cached = sessionStorage.getItem(key);
            
            if (cached) {
                var data = JSON.parse(cached);
                if (data[0]) {
                    if (typeof success === 'function') success(data[1]);
                } else {
                    if (typeof fail === 'function') fail(data[1]);
                }
                return;
            }
            
            var network = new Lampa.Reguest();
            network.timeout(10000);
            network.native(
                url,
                function (data) {
                    var results = [];
                    if (data && data.results && data.results[0]) {
                        var year = (movie.release_date || movie.first_air_date || '')
                            .replace(/\D+/g, '')
                            .substring(0, 4)
                            .replace(/^([03-9]\d|1[0-8]|2[1-9]|20[3-9])\d+$/, '');
                        
                        results = data.results.filter(function(r) {
                            var yearOk = !year || !r.releaseDate || r.releaseDate.substring(0, 4) === year;
                            var durationOk = isTv || !r.trackTimeMillis || !movie.runtime || 
                                (Math.abs(movie.runtime * 6e4 - r.trackTimeMillis) < 2e5);
                            return !!r.previewUrl && yearOk && durationOk;
                        });
                    }
                    
                    if (results.length) {
                        sessionStorage.setItem(key, JSON.stringify([true, results, search]));
                        if (typeof success === 'function') success(results);
                    } else {
                        sessionStorage.setItem(key, JSON.stringify([false, {}, search]));
                        if (typeof fail === 'function') fail({});
                    }
                    
                    network.clear();
                },
                function (error) {
                    sessionStorage.setItem(key, JSON.stringify([false, error, search]));
                    if (typeof fail === 'function') fail(error);
                    network.clear();
                },
                false,
                {
                    dataType: 'json'
                }
            );
        }
        
        function load(movie, isTv, callback) {
            var title = movie.original_title || movie.original_name || movie.title || movie.name || '';
            
            if (title === '' || !/[a-z]{3}/i.test(title)) {
                callback(null);
                return;
            }
            
            log('iTunes поиск:', title);
            
            cacheRequest(title, movie, isTv, function(data) {
                if (data && data[0]) {
                    var res = data[0];
                    var video = {
                        title: (res.trackCensoredName || res.trackName || title),
                        url: res.previewUrl,
                        iptv: true
                    };
                    log('iTunes найден:', video.url);
                    callback(video);
                } else {
                    callback(null);
                }
            }, function() {
                callback(null);
            });
        }
        
        return {
            load: load
        };
    })();

    // ==================== МОДУЛЬ ОРИГИНАЛЬНОГО НАЗВАНИЯ ====================
    var OriginalTitle = (function() {
        var storageKey = "cardify_title_cache";
        var CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
        var titleCache = Lampa.Storage.get(storageKey) || {};

        function cleanOldCache() {
            var now = Date.now();
            var changed = false;
            for (var id in titleCache) {
                if (now - titleCache[id].timestamp > CACHE_TTL) {
                    delete titleCache[id];
                    changed = true;
                }
            }
            if (changed) Lampa.Storage.set(storageKey, titleCache);
        }

        async function fetchTitles(card) {
            var orig = card.original_title || card.original_name || '';
            var alt = card.alternative_titles?.titles || card.alternative_titles?.results || [];

            var translitObj = alt.find(function(t) {
                return t.type === "Transliteration" || t.type === "romaji";
            });
            var translit = translitObj?.title || translitObj?.data?.title || translitObj?.data?.name || "";

            var ru = alt.find(function(t) { return t.iso_3166_1 === "RU"; })?.title;
            var en = alt.find(function(t) { return t.iso_3166_1 === "US"; })?.title;

            var now = Date.now();
            var cache = titleCache[card.id];
            
            if (cache && now - cache.timestamp < CACHE_TTL) {
                ru = ru || cache.ru;
                en = en || cache.en;
                translit = translit || cache.translit;
            }

            if (!ru || !en || !translit) {
                try {
                    var type = card.first_air_date ? "tv" : "movie";
                    var data = await new Promise(function(res, rej) {
                        Lampa.Api.sources.tmdb.get(
                            type + "/" + card.id + "?append_to_response=translations",
                            {},
                            res,
                            rej
                        );
                    });
                    
                    var tr = data.translations?.translations || [];

                    var translitData = tr.find(function(t) {
                        return t.type === "Transliteration" || t.type === "romaji";
                    });
                    
                    translit = translitData?.title || translitData?.data?.title || translitData?.data?.name || translit;
                    
                    if (!ru) {
                        var ruData = tr.find(function(t) { 
                            return t.iso_3166_1 === "RU" || t.iso_639_1 === "ru"; 
                        });
                        ru = ruData?.data?.title || ruData?.data?.name;
                    }
                    
                    if (!en) {
                        var enData = tr.find(function(t) { 
                            return t.iso_3166_1 === "US" || t.iso_639_1 === "en"; 
                        });
                        en = enData?.data?.title || enData?.data?.name;
                    }

                    titleCache[card.id] = { ru: ru, en: en, translit: translit, timestamp: now };
                    Lampa.Storage.set(storageKey, titleCache);
                } catch (e) {
                    log('Ошибка загрузки переводов:', e);
                }
            }

            return {
                original: orig,
                ru: ru,
                en: en,
                translit: translit
            };
        }

        function render(container, titles) {
            container.find('.cardify-original-titles').remove();
            
            var lang = Lampa.Storage.get("language") || 'ru';
            var items = [];
            
            if (titles.original) {
                items.push({ title: titles.original, label: 'Original' });
            }
            
            if (titles.translit && titles.translit !== titles.original && titles.translit !== titles.en) {
                items.push({ title: titles.translit, label: 'Translit' });
            }
            
            if (titles.en && lang !== 'en' && titles.en !== titles.original) {
                items.push({ title: titles.en, label: 'EN' });
            }
            
            if (titles.ru && lang !== 'ru') {
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

        return {
            init: cleanOldCache,
            fetch: fetchTitles,
            render: render
        };
    })();

    // ==================== STATE MACHINE ====================
    function State(object) {
        this.state = object.state;
        this.start = function () {
            this.dispath(this.state);
        };
        this.dispath = function (action_name) {
            var action = object.transitions[action_name];
            if (action) {
                action.call(this, this);
            }
        };
    }

    // ==================== PLAYER (iTunes) ====================
    var Player = function(object, video) {
        var self = this;
        
        this.paused = false;
        this.display = false;
        this.loaded = false;
        this.destroyed = false;
        this.timer = null;
        this.listener = Lampa.Subscribe();
        this.video = video;
        
        log('Player создан:', video.title);
        
        this.html = $('\
            <div class="cardify-trailer">\
                <div class="cardify-trailer__player">\
                    <video class="cardify-trailer__video" playsinline muted></video>\
                    <div class="cardify-trailer__loading">\
                        <div class="cardify-trailer__spinner"></div>\
                        <div class="cardify-trailer__status">Загрузка...</div>\
                    </div>\
                </div>\
                <div class="cardify-trailer__controlls">\
                    <div class="cardify-trailer__title">' + (video.title || '') + '</div>\
                    <div class="cardify-trailer__remote">\
                        <div class="cardify-trailer__remote-icon">\
                            <svg width="37" height="37" viewBox="0 0 37 37" fill="none" xmlns="http://www.w3.org/2000/svg">\
                                <path d="M32.52 7.22L26.8 12.94C27.85 14.52 28.46 16.42 28.46 18.46C28.46 20.86 27.61 23.06 26.2 24.78L31.87 30.46C34.72 27.27 36.46 23.07 36.46 18.46C36.46 14.21 34.98 10.3 32.52 7.22Z" fill="white" fill-opacity="0.28"/>\
                                <circle cx="18.46" cy="18.46" r="7" fill="white"/>\
                            </svg>\
                        </div>\
                        <div class="cardify-trailer__remote-text">' + Lampa.Lang.translate('cardify_enable_sound') + '</div>\
                    </div>\
                </div>\
            </div>\
        ');

        this.videoElement = this.html.find('.cardify-trailer__video')[0];
        this.loadingElement = this.html.find('.cardify-trailer__loading');
        this.statusElement = this.html.find('.cardify-trailer__status');

        this.setStatus = function(text) {
            this.statusElement.text(text);
        };

        this.initVideo = function() {
            if (self.destroyed) return;
            
            self.setStatus('Загрузка трейлера...');
            log('Загружаем:', video.url);
            
            self.videoElement.src = video.url;
            self.videoElement.muted = true;
            
            $(self.videoElement).one('loadeddata canplay', function() {
                if (self.destroyed) return;
                log('Видео готово');
                self.loadingElement.hide();
                self.loaded = true;
                self.listener.send('loaded');
            });
            
            $(self.videoElement).one('error', function(e) {
                if (self.destroyed) return;
                log('Ошибка загрузки видео');
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
                
                if (left <= 10) {
                    var vol = Math.max(0, (left - 5) / 5);
                    if (!self.videoElement.muted) {
                        self.videoElement.volume = vol;
                    }
                    
                    if (left <= 5) {
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
            self.listener.send('paused');
        });

        $(this.videoElement).on('ended', function() {
            if (self.destroyed) return;
            self.listener.send('ended');
        });

        // Запуск загрузки
        setTimeout(function() {
            self.initVideo();
        }, 100);

        this.play = function() {
            if (this.destroyed) return;
            try { 
                var p = this.videoElement.play();
                if (p) p.catch(function(e) { log('Autoplay blocked'); });
            } catch (e) {}
        };

        this.pause = function() {
            if (this.destroyed) return;
            try { this.videoElement.pause(); } catch (e) {}
        };

        this.unmute = function() {
            if (this.destroyed) return;
            this.videoElement.muted = false;
            this.videoElement.volume = 1;
            this.html.find('.cardify-trailer__remote').remove();
            window.cardify_fist_unmute = true;
        };

        this.show = function() {
            if (this.destroyed) return;
            this.html.addClass('display');
            this.display = true;
        };

        this.hide = function() {
            if (this.destroyed) return;
            this.html.removeClass('display');
            this.display = false;
        };

        this.render = function() {
            return this.html;
        };

        this.destroy = function() {
            this.destroyed = true;
            this.loaded = false;
            this.display = false;
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
        this.background = this.object.activity.render().find('.full-start__background');
        this.startblock = this.object.activity.render().find('.cardify');
        this.head = $('.head');
        this.timelauch = 1500;
        this.firstlauch = false;

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
                        // nothing
                    } else if (Lampa.Controller.enabled().name == 'full_start' && self.same()) {
                        if (self.player.loaded) state.start();
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
                if (self.destroyed) {
                    clearInterval(self.timer_anim);
                    return;
                }
                var elapsed = Date.now() - started;
                if (elapsed > self.timelauch) clearInterval(self.timer_anim);
                loader.width(Math.round(elapsed / self.timelauch * 100) + '%');
            }, 50);
        };

        this.preview = function() {
            if (this.destroyed) return;
            
            // Для iTunes используем постер фильма
            var img = this.object.activity.render().find('.full-start__background img').attr('src') || 
                      this.object.activity.render().find('.full--poster').attr('src') || '';
            
            var preview = $('\
                <div class="cardify-preview">\
                    <div>\
                        <img class="cardify-preview__img" src="' + img + '" />\
                        <div class="cardify-preview__loader"></div>\
                        <div class="cardify-preview__icon">\
                            <svg viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>\
                        </div>\
                    </div>\
                </div>\
            ');

            var target = this.object.activity.render().find('.cardify__right');
            if (target.length) {
                target.append(preview);
            }
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
                left: out,
                up: out,
                down: out,
                right: out,
                back: function() {
                    self.player.destroy();
                    self.object.activity.render().find('.cardify-preview').remove();
                    out();
                }
            });

            Lampa.Controller.toggle('cardify_trailer');
        };

        this.start = function() {
            var toggle = function() { 
                if (!self.destroyed) self.state.dispath('toggle'); 
            };

            var destroy = function(e) {
                if (e.type == 'destroy' && e.object.activity === self.object.activity) {
                    remove();
                }
            };

            var remove = function() {
                Lampa.Listener.remove('activity', destroy);
                Lampa.Controller.listener.remove('toggle', toggle);
                self.destroy();
            };

            Lampa.Listener.follow('activity', destroy);
            Lampa.Controller.listener.follow('toggle', toggle);

            this.player = new Player(this.object, this.video);

            this.player.listener.follow('loaded', function() {
                if (self.destroyed) return;
                self.preview();
                self.state.start();
            });

            this.player.listener.follow('play', function() {
                if (self.destroyed) return;
                clearTimeout(self.timer_show);

                if (!self.firstlauch) {
                    self.firstlauch = true;
                    self.timelauch = 5000;
                }

                self.timer_show = setTimeout(function() {
                    if (self.destroyed) return;
                    self.player.show();
                    self.background.addClass('nodisplay');
                    self.startblock.addClass('nodisplay');
                    self.head.addClass('nodisplay');
                    self.controll();
                }, 500);
            });

            this.player.listener.follow('ended,error', function() {
                if (self.destroyed) return;
                self.state.dispath('hide');

                if (Lampa.Controller.enabled().name == 'cardify_trailer') {
                    Lampa.Controller.toggle('full_start');
                }

                self.object.activity.render().find('.cardify-preview').remove();
                setTimeout(remove, 300);
            });

            this.object.activity.render().find('.activity__body').prepend(this.player.render());
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

        OriginalTitle.init();

        // Переводы
        Lampa.Lang.add({
            cardify_enable_sound: {
                ru: 'Включить звук',
                en: 'Enable sound',
                uk: 'Увімкнути звук'
            },
            cardify_enable_trailer: {
                ru: 'Автовоспроизведение трейлера',
                en: 'Autoplay trailer',
                uk: 'Автовідтворення трейлера'
            },
            cardify_show_original_title: {
                ru: 'Показывать оригинальное название',
                en: 'Show original title',
                uk: 'Показувати оригінальну назву'
            }
        });

        // ШАБЛОН С 3 РЕАКЦИЯМИ
        Lampa.Template.add('full_start_new', '\
<div class="full-start-new cardify">\
    <div class="full-start-new__body">\
        <div class="full-start-new__left hide">\
            <div class="full-start-new__poster">\
                <img class="full-start-new__img full--poster" />\
            </div>\
        </div>\
        <div class="full-start-new__right">\
            <div class="cardify__left">\
                <div class="full-start-new__head"></div>\
                <div class="full-start-new__title">{title}</div>\
                <div class="full-start-new__details"></div>\
                <div class="full-start-new__buttons">\
                    <div class="full-start__button selector button--play">\
                        <svg width="28" height="29" viewBox="0 0 28 29" fill="none" xmlns="http://www.w3.org/2000/svg">\
                            <circle cx="14" cy="14.5" r="13" stroke="currentColor" stroke-width="2.7"/>\
                            <path d="M18.07 13.63C18.74 14.02 18.74 14.98 18.07 15.37L11.75 19.02C11.08 19.4 10.25 18.92 10.25 18.15V10.85C10.25 10.08 11.08 9.6 11.75 9.98L18.07 13.63Z" fill="currentColor"/>\
                        </svg>\
                        <span>#{title_watch}</span>\
                    </div>\
                    <div class="full-start__button selector button--book">\
                        <svg width="21" height="32" viewBox="0 0 21 32" fill="none" xmlns="http://www.w3.org/2000/svg">\
                            <path d="M2 1.5H19C19.28 1.5 19.5 1.72 19.5 2V27.96C19.5 28.38 19.03 28.61 18.7 28.36L12.62 23.73C11.37 22.78 9.63 22.78 8.38 23.73L2.3 28.36C1.97 28.61 1.5 28.38 1.5 27.96V2C1.5 1.72 1.72 1.5 2 1.5Z" stroke="currentColor" stroke-width="2.5"/>\
                        </svg>\
                        <span>#{settings_input_links}</span>\
                    </div>\
                    <div class="full-start__button selector button--reaction">\
                        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">\
                            <path d="M16 2C8.27 2 2 8.27 2 16s6.27 14 14 14 14-6.27 14-14S23.73 2 16 2zm0 25.2c-6.18 0-11.2-5.02-11.2-11.2S9.82 4.8 16 4.8 27.2 9.82 27.2 16 22.18 27.2 16 27.2z" fill="currentColor"/>\
                            <circle cx="11" cy="13" r="2" fill="currentColor"/>\
                            <circle cx="21" cy="13" r="2" fill="currentColor"/>\
                            <path d="M16 24c3.31 0 6-2.24 6-5H10c0 2.76 2.69 5 6 5z" fill="currentColor"/>\
                        </svg>\
                        <span>#{title_reactions}</span>\
                    </div>\
                    <div class="full-start__button selector button--subscribe hide">\
                        <svg width="25" height="30" viewBox="0 0 25 30" fill="none" xmlns="http://www.w3.org/2000/svg">\
                            <path d="M6.02 24C6.27 27.36 9.08 30 12.5 30C15.92 30 18.73 27.36 18.98 24H15.96C15.72 25.7 14.26 27 12.5 27C10.74 27 9.28 25.7 9.04 24H6.02Z" fill="currentColor"/>\
                            <path d="M3.82 14.6V10.27C3.82 5.41 7.72 1.5 12.5 1.5C17.28 1.5 21.18 5.41 21.18 10.27V14.6C21.18 15.85 21.54 17.07 22.22 18.12L23.07 19.45C24.21 21.21 22.94 23.5 20.91 23.5H4.09C2.06 23.5 0.79 21.21 1.93 19.45L2.78 18.12C3.46 17.07 3.82 15.85 3.82 14.6Z" stroke="currentColor" stroke-width="2.5"/>\
                        </svg>\
                        <span>#{title_subscribe}</span>\
                    </div>\
                    <div class="full-start__button selector button--options">\
                        <svg width="38" height="10" viewBox="0 0 38 10" fill="none" xmlns="http://www.w3.org/2000/svg">\
                            <circle cx="4.89" cy="4.99" r="4.75" fill="currentColor"/>\
                            <circle cx="18.97" cy="4.99" r="4.75" fill="currentColor"/>\
                            <circle cx="33.06" cy="4.99" r="4.75" fill="currentColor"/>\
                        </svg>\
                    </div>\
                </div>\
            </div>\
            <div class="cardify__right">\
                <div class="full-start-new__reactions full-start-new__reactions--cardify selector">\
                    <div>#{reactions_none}</div>\
                </div>\
                <div class="full-start-new__rate-line">\
                    <div class="full-start__pg hide"></div>\
                    <div class="full-start__status hide"></div>\
                </div>\
            </div>\
        </div>\
    </div>\
    <div class="hide buttons--container">\
        <div class="full-start__button view--torrent hide">\
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" width="50px" height="50px">\
                <path d="M25,2C12.32,2,2,12.32,2,25s10.32,23,23,23s23-10.32,23-23S37.68,2,25,2z" fill="currentColor"/>\
            </svg>\
            <span>#{full_torrents}</span>\
        </div>\
        <div class="full-start__button selector view--trailer">\
            <svg height="70" viewBox="0 0 80 70" fill="none" xmlns="http://www.w3.org/2000/svg">\
                <path fill-rule="evenodd" d="M71.26 2.09C74.7 3.24 77.41 6.63 78.33 10.93C80 18.73 80 35 80 35s0 16.27-1.67 24.07c-.92 4.3-3.63 7.69-7.07 8.84C65.02 70 40 70 40 70s-25.02 0-31.26-2.09c-3.44-1.15-6.15-4.54-7.07-8.84C0 51.27 0 35 0 35s0-16.27 1.67-24.07c.92-4.3 3.63-7.69 7.07-8.84C14.98 0 40 0 40 0s25.02 0 31.26 2.09zM55.59 35L29.98 49.57V20.43L55.59 35z" fill="currentColor"/>\
            </svg>\
            <span>#{full_trailers}</span>\
        </div>\
    </div>\
</div>');

        // CSS СТИЛИ
        var style = $('<style id="cardify-styles">\
            /* === ОСНОВНЫЕ СТИЛИ === */\
            .cardify{transition:all .3s}\
            .cardify .full-start-new__body{height:80vh}\
            .cardify .full-start-new__right{display:flex;align-items:flex-end}\
            .cardify .full-start-new__head{margin-bottom:0.3em}\
            \
            /* === ЛОГОТИП/НАЗВАНИЕ - БОЛЬШОЙ РАЗМЕР === */\
            .cardify .full-start-new__title,\
            .cardify .full-start-new__title *{\
                font-size:4em !important;\
                line-height:1.1 !important;\
            }\
            .cardify .full-start-new__title{\
                text-shadow:0 2px 8px rgba(0,0,0,0.5);\
                margin-bottom:0.1em;\
            }\
            /* Логотип-картинка */\
            .cardify .full-start-new__title img,\
            .cardify .full-start-new__head img,\
            .cardify .full-start__title-img,\
            .cardify img.full--logo{\
                max-height:10em !important;\
                min-height:4em !important;\
                max-width:85% !important;\
                height:auto !important;\
                width:auto !important;\
                object-fit:contain !important;\
                display:block !important;\
            }\
            \
            /* === ДЕТАЛИ (год, жанры) === */\
            .cardify .full-start-new__details{\
                margin-top:0.8em;\
                margin-bottom:0.5em;\
                font-size:1.3em;\
                opacity:0.7;\
            }\
            \
            /* === ОРИГИНАЛЬНЫЕ НАЗВАНИЯ === */\
            .cardify-original-titles{\
                margin-bottom:1em;\
                margin-top:0.3em;\
                display:flex;\
                flex-direction:column;\
                gap:0.25em;\
            }\
            .cardify-original-titles__item{\
                display:flex;\
                align-items:center;\
                gap:0.6em;\
                font-size:1.3em;\
                opacity:0.8;\
            }\
            .cardify-original-titles__text{\
                color:#fff;\
            }\
            .cardify-original-titles__label{\
                font-size:0.65em;\
                padding:0.15em 0.4em;\
                background:rgba(255,255,255,0.15);\
                border-radius:0.25em;\
                text-transform:uppercase;\
                letter-spacing:0.03em;\
                opacity:0.6;\
            }\
            \
            /* === LAYOUT === */\
            .cardify__left{flex-grow:1;max-width:70%}\
            .cardify__right{display:flex;align-items:center;flex-shrink:0;position:relative;flex-direction:column;align-items:flex-end}\
            \
            /* === 3 РЕАКЦИИ === */\
            .cardify .full-start-new__reactions--cardify{\
                margin:0 0 1em 0 !important;\
            }\
            .cardify .full-start-new__reactions--cardify:not(.focus){\
                margin:0 0 1em 0 !important;\
            }\
            /* Показываем 3 реакции вместо 1 */\
            .cardify .full-start-new__reactions--cardify:not(.focus) > div{\
                display:flex !important;\
                gap:0.5em;\
            }\
            .cardify .full-start-new__reactions--cardify:not(.focus) .reaction:nth-child(n+4){\
                display:none !important;\
            }\
            .cardify .full-start-new__reactions--cardify:not(.focus) .reaction{\
                position:relative;\
            }\
            .cardify .full-start-new__reactions--cardify:not(.focus) .reaction__count{\
                position:absolute;\
                top:25%;\
                left:90%;\
                font-size:1.1em;\
                font-weight:500;\
            }\
            \
            .cardify .full-start-new__rate-line{margin:0}\
            .cardify .full-start-new__rate-line>*:last-child{margin-right:0 !important}\
            \
            /* === ФОНОВОЕ ИЗОБРАЖЕНИЕ === */\
            .cardify__background{left:0}\
            .cardify__background.loaded:not(.dim){opacity:1}\
            .cardify__background.nodisplay{opacity:0 !important}\
            .cardify.nodisplay{transform:translate3d(0,50%,0);opacity:0}\
            body:not(.menu--open) .cardify__background{mask-image:linear-gradient(to bottom,white 50%,rgba(255,255,255,0) 100%)}\
            \
            /* === ТРЕЙЛЕР === */\
            .cardify-trailer{opacity:0;transition:opacity .3s;position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:#000}\
            .cardify-trailer.display{opacity:1}\
            .cardify-trailer__player{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center}\
            .cardify-trailer__video{width:100%;height:100%;object-fit:contain;background:#000}\
            .cardify-trailer__loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:#fff}\
            .cardify-trailer__spinner{width:50px;height:50px;border:4px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:cardify-spin 1s linear infinite;margin:0 auto 1em}\
            .cardify-trailer__status{font-size:1.2em;opacity:0.7}\
            @keyframes cardify-spin{to{transform:rotate(360deg)}}\
            .cardify-trailer__controlls{position:fixed;left:1.5em;right:1.5em;bottom:1.5em;display:flex;align-items:flex-end;transform:translateY(100%);opacity:0;transition:all .3s}\
            .cardify-trailer.display .cardify-trailer__controlls{transform:translateY(0);opacity:1}\
            .cardify-trailer__title{flex-grow:1;padding-right:2em;font-size:2em;font-weight:600;color:#fff;text-shadow:0 2px 4px rgba(0,0,0,0.5)}\
            .cardify-trailer__remote{display:flex;align-items:center;color:#fff}\
            .cardify-trailer__remote-icon{width:2.5em;height:2.5em}\
            .cardify-trailer__remote-icon svg{width:100%;height:100%}\
            .cardify-trailer__remote-text{margin-left:1em;font-size:1.2em}\
            \
            /* === ПРЕВЬЮ ТРЕЙЛЕРА === */\
            .cardify-preview{position:relative;border-radius:.4em;width:9em;height:5.5em;background:#000;overflow:hidden;margin-bottom:1em}\
            .cardify-preview>div{position:relative;width:100%;height:100%}\
            .cardify-preview__img{width:100%;height:100%;object-fit:cover}\
            .cardify-preview__loader{position:absolute;left:0;bottom:0;height:4px;background:rgba(255,255,255,0.9);width:0;transition:width .05s linear}\
            .cardify-preview__icon{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:2em;height:2em;background:rgba(0,0,0,0.5);border-radius:50%;display:flex;align-items:center;justify-content:center}\
            .cardify-preview__icon svg{width:1.2em;height:1.2em}\
            \
            /* === ШАПКА === */\
            .head.nodisplay{transform:translateY(-100%)}\
            \
            /* Скрываем старый плагин названий */\
            .cardify .original_title{display:none !important}\
        </style>');
        
        $('head').append(style);

        // Настройки
        var icon = '<svg width="36" height="28" viewBox="0 0 36 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="1.5" width="33" height="25" rx="3.5" stroke="white" stroke-width="3"/><rect x="5" y="14" width="17" height="4" rx="2" fill="white"/><rect x="5" y="20" width="10" height="3" rx="1.5" fill="white"/><rect x="25" y="20" width="6" height="3" rx="1.5" fill="white"/></svg>';

        Lampa.SettingsApi.addComponent({
            component: 'cardify',
            icon: icon,
            name: 'Cardify Free v' + PLUGIN_VERSION
        });

        Lampa.SettingsApi.addParam({
            component: 'cardify',
            param: {
                name: 'cardify_run_trailers',
                type: 'trigger',
                default: true
            },
            field: {
                name: Lampa.Lang.translate('cardify_enable_trailer')
            }
        });

        Lampa.SettingsApi.addParam({
            component: 'cardify',
            param: {
                name: 'cardify_show_original_title',
                type: 'trigger',
                default: true
            },
            field: {
                name: Lampa.Lang.translate('cardify_show_original_title')
            }
        });

        // Основной слушатель
        Lampa.Listener.follow('full', function(e) {
            if (e.type == 'complite') {
                log('Full complite');
                
                var render = e.object.activity.render();
                render.find('.full-start__background').addClass('cardify__background');

                // Принудительно увеличиваем логотип через JS
                setTimeout(function() {
                    var titleImg = render.find('.full-start-new__title img, .full-start-new__head img, .full-start__title-img');
                    if (titleImg.length) {
                        titleImg.css({
                            'max-height': '10em',
                            'min-height': '4em',
                            'height': 'auto',
                            'width': 'auto',
                            'max-width': '85%'
                        });
                    }
                }, 100);

                // Оригинальные названия
                if (Lampa.Storage.field('cardify_show_original_title') !== false && e.data.movie) {
                    var cardifyLeft = render.find('.cardify__left');
                    
                    OriginalTitle.fetch(e.data.movie).then(function(titles) {
                        OriginalTitle.render(cardifyLeft, titles);
                    });
                }

                // Трейлеры iTunes
                if (Lampa.Storage.field('cardify_run_trailers') !== false) {
                    var movie = e.data.movie;
                    var isTv = !!(e.object && e.object.method && e.object.method === 'tv');
                    
                    if (movie) {
                        iTunesTrailer.load(movie, isTv, function(video) {
                            if (video && !e.object.activity.trailer_ready) {
                                log('iTunes трейлер найден:', video.title);
                                
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
            }
        });

        log('Плагин инициализирован');
    }

    if (window.appready) {
        startPlugin();
    } else {
        Lampa.Listener.follow('app', function(e) {
            if (e.type == 'ready') startPlugin();
        });
    }

})();
