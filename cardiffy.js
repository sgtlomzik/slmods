(function () {
    'use strict';

    /**
     * Cardify Free Plugin
     * @version 1.3.0
     * @date 2025-01-XX
     * 
     * Changelog:
     * 1.3.0 - Интегрирован плагин оригинального названия
     * 1.2.0 - Исправлена блокировка интерфейса
     * 1.1.0 - Заменён YouTube на Invidious прокси
     * 1.0.0 - Первая версия без проверки премиума
     */
    var PLUGIN_VERSION = '1.3.0';

    var DEBUG = true;
    
    function log() {
        if (DEBUG) {
            var args = Array.prototype.slice.call(arguments);
            args.unshift('[Cardify v' + PLUGIN_VERSION + ']');
            console.log.apply(console, args);
        }
    }

    log('Загрузка плагина...');

    // ==================== МОДУЛЬ ОРИГИНАЛЬНОГО НАЗВАНИЯ ====================
    var OriginalTitle = (function() {
        var storageKey = "cardify_title_cache";
        var CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 дней
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
            
            // Оригинальное название
            if (titles.original) {
                items.push({
                    title: titles.original,
                    label: 'Original'
                });
            }
            
            // Транслитерация (если отличается)
            if (titles.translit && titles.translit !== titles.original && titles.translit !== titles.en) {
                items.push({
                    title: titles.translit,
                    label: 'Translit'
                });
            }
            
            // Английское (если язык не английский и отличается от оригинала)
            if (titles.en && lang !== 'en' && titles.en !== titles.original) {
                items.push({
                    title: titles.en,
                    label: 'EN'
                });
            }
            
            // Русское (если язык не русский)
            if (titles.ru && lang !== 'ru') {
                items.push({
                    title: titles.ru,
                    label: 'RU'
                });
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

            // Вставляем после details (год, жанры)
            var details = container.find('.full-start-new__details');
            if (details.length) {
                details.after(html);
            } else {
                container.find('.full-start-new__title').after(html);
            }
        }

        return {
            init: cleanOldCache,
            fetch: fetchTitles,
            render: render
        };
    })();

    // ==================== INVIDIOUS INSTANCES ====================
    var INVIDIOUS_INSTANCES = [
        'https://iv.ggtyler.dev',
        'https://invidious.nerdvpn.de', 
        'https://yt.artemislena.eu',
        'https://invidious.privacyredirect.com',
        'https://invidious.protokolla.fi',
        'https://inv.nadeko.net'
    ];

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

    // ==================== PLAYER ====================
    var Player = function(object, video) {
        var self = this;
        
        this.paused = false;
        this.display = false;
        this.loaded = false;
        this.loading = false;
        this.destroyed = false;
        this.timer = null;
        this.listener = Lampa.Subscribe();
        this.videoId = video.id;
        this.videoTitle = video.title;
        this.currentRequest = null;
        
        log('Player создан:', video.id);
        
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

        this.tryGetVideo = function(instances, index, callback) {
            if (self.destroyed) return;
            
            if (index >= instances.length) {
                log('Все инстансы недоступны');
                callback(null);
                return;
            }

            var instance = instances[index];
            var apiUrl = instance + '/api/v1/videos/' + self.videoId + '?fields=formatStreams,adaptiveFormats';
            
            self.setStatus('Проверка ' + (index + 1) + '/' + instances.length);
            log('Запрос:', apiUrl);

            self.currentRequest = $.ajax({
                url: apiUrl,
                timeout: 8000,
                dataType: 'json',
                success: function(data) {
                    if (self.destroyed) return;
                    
                    var videoUrl = null;
                    
                    if (data.formatStreams && data.formatStreams.length) {
                        var streams = data.formatStreams.sort(function(a, b) {
                            return (parseInt(b.qualityLabel) || 0) - (parseInt(a.qualityLabel) || 0);
                        });
                        
                        for (var i = 0; i < streams.length; i++) {
                            var q = parseInt(streams[i].qualityLabel) || 0;
                            if (q <= 720 && streams[i].url) {
                                videoUrl = streams[i].url;
                                break;
                            }
                        }
                        
                        if (!videoUrl && streams[0] && streams[0].url) {
                            videoUrl = streams[0].url;
                        }
                    }
                    
                    if (videoUrl) {
                        callback(videoUrl);
                    } else {
                        self.tryGetVideo(instances, index + 1, callback);
                    }
                },
                error: function() {
                    if (self.destroyed) return;
                    self.tryGetVideo(instances, index + 1, callback);
                }
            });
        };

        this.initVideo = function() {
            if (self.loading || self.destroyed) return;
            self.loading = true;
            
            self.setStatus('Поиск трейлера...');
            
            self.tryGetVideo(INVIDIOUS_INSTANCES, 0, function(url) {
                if (self.destroyed) return;
                self.loading = false;
                
                if (url) {
                    self.setStatus('Загрузка...');
                    
                    self.videoElement.src = url;
                    self.videoElement.muted = true;
                    
                    $(self.videoElement).one('loadeddata canplay', function() {
                        if (self.destroyed) return;
                        self.loadingElement.hide();
                        self.loaded = true;
                        self.listener.send('loaded');
                    });
                    
                    $(self.videoElement).one('error', function() {
                        if (self.destroyed) return;
                        self.listener.send('error');
                    });
                    
                    self.videoElement.load();
                } else {
                    self.listener.send('error');
                }
            });
        };

        $(this.videoElement).on('playing', function() {
            if (self.destroyed) return;
            self.paused = false;
            
            clearInterval(self.timer);
            self.timer = setInterval(function() {
                if (!self.videoElement.duration || self.destroyed) return;
                
                var left = self.videoElement.duration - self.videoElement.currentTime;
                
                if (left <= 18) {
                    var vol = Math.max(0, (left - 13) / 5);
                    if (!self.videoElement.muted) {
                        self.videoElement.volume = vol;
                    }
                    
                    if (left <= 13) {
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

        setTimeout(function() {
            self.initVideo();
        }, 100);

        this.play = function() {
            if (this.destroyed) return;
            try { 
                var p = this.videoElement.play();
                if (p) p.catch(function(e) {});
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
            this.loading = false;
            clearInterval(this.timer);
            
            if (this.currentRequest) {
                try { this.currentRequest.abort(); } catch(e) {}
            }
            
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
                        if (self.player.loaded) {
                            state.start();
                        }
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
            var preview = $('\
                <div class="cardify-preview">\
                    <div>\
                        <img class="cardify-preview__img" src="https://img.youtube.com/vi/' + this.video.id + '/mqdefault.jpg" />\
                        <div class="cardify-preview__loader"></div>\
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
            var self = this;
            
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

        // Инициализация кэша названий
        OriginalTitle.init();

        // Переводы
        Lampa.Lang.add({
            cardify_enable_sound: {
                ru: 'Включить звук',
                en: 'Enable sound',
                uk: 'Увімкнути звук'
            },
            cardify_enable_trailer: {
                ru: 'Показывать трейлер',
                en: 'Show trailer',
                uk: 'Показувати трейлер'
            },
            cardify_show_original_title: {
                ru: 'Показывать оригинальное название',
                en: 'Show original title',
                uk: 'Показувати оригінальну назву'
            }
        });

        // ШАБЛОН КАРТОЧКИ
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
                            <path d="M18.0739 13.634C18.7406 14.0189 18.7406 14.9811 18.0739 15.366L11.751 19.0166C11.0843 19.4015 10.251 18.9204 10.251 18.1506L10.251 10.8494C10.251 10.0796 11.0843 9.5985 11.751 9.9834L18.0739 13.634Z" fill="currentColor"/>\
                        </svg>\
                        <span>#{title_watch}</span>\
                    </div>\
                    <div class="full-start__button selector button--book">\
                        <svg width="21" height="32" viewBox="0 0 21 32" fill="none" xmlns="http://www.w3.org/2000/svg">\
                            <path d="M2 1.5H19C19.2761 1.5 19.5 1.72386 19.5 2V27.9618C19.5 28.3756 19.0261 28.6103 18.697 28.3595L12.6212 23.7303C11.3682 22.7757 9.63183 22.7757 8.37885 23.7303L2.30302 28.3595C1.9739 28.6103 1.5 28.3756 1.5 27.9618V2C1.5 1.72386 1.72386 1.5 2 1.5Z" stroke="currentColor" stroke-width="2.5"/>\
                        </svg>\
                        <span>#{settings_input_links}</span>\
                    </div>\
                    <div class="full-start__button selector button--reaction">\
                        <svg width="38" height="34" viewBox="0 0 38 34" fill="none" xmlns="http://www.w3.org/2000/svg">\
                            <path d="M37.208 10.97L12.07 0.11C11.72-0.04 11.32-0.04 10.97 0.11C10.63 0.25 10.35 0.53 10.2 0.88L0.11 25.25C0.04 25.42 0 25.61 0 25.8C0 25.98 0.04 26.17 0.11 26.34C0.18 26.51 0.29 26.67 0.42 26.8C0.55 26.94 0.71 27.04 0.88 27.11L17.25 33.89C17.59 34.04 17.99 34.04 18.34 33.89L29.66 29.2C29.83 29.13 29.99 29.03 30.12 28.89C30.25 28.76 30.36 28.6 30.43 28.43L37.21 12.07C37.28 11.89 37.32 11.71 37.32 11.52C37.32 11.33 37.28 11.15 37.21 10.97ZM20.43 29.94L21.88 26.43L25.39 27.89L20.43 29.94ZM28.34 26.02L21.65 23.25C21.3 23.11 20.91 23.11 20.56 23.25C20.21 23.4 19.93 23.67 19.79 24.02L17.02 30.71L3.29 25.02L12.29 3.29L34.03 12.29L28.34 26.02Z" fill="currentColor"/>\
                            <path d="M25.35 16.98L24.26 14.34L16.96 17.37L15.72 14.38L13.09 15.47L15.42 21.09L25.35 16.98Z" fill="currentColor"/>\
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
                <div class="full-start-new__reactions selector">\
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
                <path d="M25,2C12.317,2,2,12.317,2,25s10.317,23,23,23s23-10.317,23-23S37.683,2,25,2z M40.5,30.963c-3.1,0-4.9-2.4-4.9-2.4 S34.1,35,27,35c-1.4,0-3.6-0.837-3.6-0.837l4.17,9.643C26.727,43.92,25.874,44,25,44c-2.157,0-4.222-0.377-6.155-1.039L9.237,16.851 c0,0-0.7-1.2,0.4-1.5c1.1-0.3,5.4-1.2,5.4-1.2s1.475-0.494,1.8,0.5c0.5,1.3,4.063,11.112,4.063,11.112S22.6,29,27.4,29 c4.7,0,5.9-3.437,5.7-3.937c-1.2-3-4.993-11.862-4.993-11.862s-0.6-1.1,0.8-1.4c1.4-0.3,3.8-0.7,3.8-0.7s1.105-0.163,1.6,0.8 c0.738,1.437,5.193,11.262,5.193,11.262s1.1,2.9,3.3,2.9c0.464,0,0.834-0.046,1.152-0.104c-0.082,1.635-0.348,3.221-0.817,4.722 C42.541,30.867,41.756,30.963,40.5,30.963z" fill="currentColor"/>\
            </svg>\
            <span>#{full_torrents}</span>\
        </div>\
        <div class="full-start__button selector view--trailer">\
            <svg height="70" viewBox="0 0 80 70" fill="none" xmlns="http://www.w3.org/2000/svg">\
                <path fill-rule="evenodd" clip-rule="evenodd" d="M71.26 2.09C74.7 3.24 77.41 6.63 78.33 10.93C80 18.73 80 35 80 35C80 35 80 51.27 78.33 59.07C77.41 63.37 74.7 66.76 71.26 67.91C65.02 70 40 70 40 70C40 70 14.98 70 8.74 67.91C5.3 66.76 2.59 63.37 1.67 59.07C0 51.27 0 35 0 35C0 35 0 18.73 1.67 10.93C2.59 6.63 5.3 3.24 8.74 2.09C14.98 0 40 0 40 0C40 0 65.02 0 71.26 2.09ZM55.59 35L29.98 49.57V20.43L55.59 35Z" fill="currentColor"/>\
            </svg>\
            <span>#{full_trailers}</span>\
        </div>\
    </div>\
</div>');

        // CSS СТИЛИ
        var style = $('<style>\
            /* === CARDIFY MAIN === */\
            .cardify{transition:all .3s}\
            .cardify .full-start-new__body{height:80vh}\
            .cardify .full-start-new__right{display:flex;align-items:flex-end}\
            .cardify .full-start-new__head{margin-bottom:0.3em}\
            .cardify .full-start-new__title{\
                text-shadow:0 0 .1em rgba(0,0,0,0.3);\
                font-size:5em !important;\
                line-height:1.1 !important;\
                margin-bottom:0.15em\
            }\
            /* Логотип 24em */\
            .cardify .full-start-new__title img,\
            .cardify .full-start-new__head img,\
            .cardify img.full--logo,\
            .cardify .full-start__title-img{\
                max-height:24em !important;\
                max-width:90% !important;\
                height:auto !important;\
                width:auto !important;\
                object-fit:contain !important;\
            }\
            .cardify .full-start-new__details{\
                margin-bottom:0.5em;\
                font-size:1.3em;\
                opacity:0.7\
            }\
            .cardify__left{flex-grow:1;max-width:70%}\
            .cardify__right{display:flex;align-items:center;flex-shrink:0;position:relative}\
            .cardify .full-start-new__reactions{margin:0;margin-right:-2.8em}\
            .cardify .full-start-new__reactions:not(.focus){margin:0}\
            .cardify .full-start-new__reactions:not(.focus)>div:not(:first-child){display:none}\
            .cardify .full-start-new__rate-line{margin:0;margin-left:3.5em}\
            .cardify__background{left:0}\
            .cardify__background.loaded:not(.dim){opacity:1}\
            .cardify__background.nodisplay{opacity:0 !important}\
            .cardify.nodisplay{transform:translate3d(0,50%,0);opacity:0}\
            \
            /* === ORIGINAL TITLES === */\
            .cardify-original-titles{\
                margin-bottom:1em;\
                display:flex;\
                flex-direction:column;\
                gap:0.3em;\
            }\
            .cardify-original-titles__item{\
                display:flex;\
                align-items:center;\
                gap:0.8em;\
                font-size:1.4em;\
                opacity:0.85;\
            }\
            .cardify-original-titles__text{\
                color:#fff;\
                text-shadow:0 1px 3px rgba(0,0,0,0.5);\
            }\
            .cardify-original-titles__label{\
                font-size:0.7em;\
                padding:0.2em 0.5em;\
                background:rgba(255,255,255,0.15);\
                border-radius:0.3em;\
                text-transform:uppercase;\
                letter-spacing:0.05em;\
                opacity:0.7;\
            }\
            \
            /* === TRAILER === */\
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
            .cardify-trailer__title{flex-grow:1;padding-right:2em;font-size:2.5em;font-weight:600;color:#fff;text-shadow:0 2px 4px rgba(0,0,0,0.5)}\
            .cardify-trailer__remote{display:flex;align-items:center;color:#fff}\
            .cardify-trailer__remote-icon{width:2.5em;height:2.5em}\
            .cardify-trailer__remote-icon svg{width:100%;height:100%}\
            .cardify-trailer__remote-text{margin-left:1em;font-size:1.2em}\
            \
            /* === PREVIEW === */\
            .cardify-preview{position:relative;border-radius:.3em;width:8em;height:5em;background:#000;overflow:hidden;margin-left:1em}\
            .cardify-preview>div{position:relative;width:100%;height:100%}\
            .cardify-preview__img{width:100%;height:100%;object-fit:cover}\
            .cardify-preview__loader{position:absolute;left:0;bottom:0;height:4px;background:rgba(255,255,255,0.9);width:0;transition:width .05s linear}\
            \
            /* === OTHER === */\
            .head.nodisplay{transform:translateY(-100%)}\
            body:not(.menu--open) .cardify__background{mask-image:linear-gradient(to bottom,white 50%,rgba(255,255,255,0) 100%)}\
            \
            /* Скрываем старый плагин названий если есть */\
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

        function getVideo(data) {
            if (!data.videos || !data.videos.results) return null;
            
            var items = data.videos.results.filter(function(v) {
                return v.site === 'YouTube' && v.key;
            }).map(function(v) {
                return {
                    title: v.name || '',
                    id: v.key,
                    code: v.iso_639_1,
                    time: new Date(v.published_at).getTime()
                };
            });

            if (!items.length) return null;

            items.sort(function(a, b) { return b.time - a.time; });

            var lang = Lampa.Storage.field('tmdb_lang') || 'ru';
            var myLang = items.filter(function(v) { return v.code === lang; });
            var enLang = items.filter(function(v) { return v.code === 'en'; });

            return myLang[0] || enLang[0] || items[0];
        }

        // Основной слушатель
        Lampa.Listener.follow('full', function(e) {
            if (e.type == 'complite') {
                log('Full complite');
                
                var render = e.object.activity.render();
                render.find('.full-start__background').addClass('cardify__background');

                // === ОРИГИНАЛЬНЫЕ НАЗВАНИЯ ===
                if (Lampa.Storage.field('cardify_show_original_title') !== false && e.data.movie) {
                    var cardifyLeft = render.find('.cardify__left');
                    
                    OriginalTitle.fetch(e.data.movie).then(function(titles) {
                        OriginalTitle.render(cardifyLeft, titles);
                    });
                }

                // === ТРЕЙЛЕРЫ ===
                if (!Lampa.Storage.field('cardify_run_trailers')) return;

                var trailer = getVideo(e.data);

                if (!trailer) return;

                if (Lampa.Activity.active().activity === e.object.activity) {
                    new Trailer(e.object, trailer);
                } else {
                    var follow = function(a) {
                        if (a.type == 'start' && a.object.activity === e.object.activity && !e.object.activity.trailer_ready) {
                            Lampa.Listener.remove('activity', follow);
                            new Trailer(e.object, trailer);
                        }
                    };
                    Lampa.Listener.follow('activity', follow);
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
