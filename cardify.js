(function () {
    'use strict';

    // Список Invidious/Piped инстансов (прокси для YouTube)
    var PROXY_INSTANCES = [
        'https://inv.nadeko.net',
        'https://invidious.nerdvpn.de',
        'https://invidious.jing.rocks',
        'https://piped.video',
        'https://pipedapi.kavin.rocks',
        'https://vid.puffyan.us',
        'https://invidious.snopyta.org',
        'https://yewtu.be'
    ];

    // Простая машина состояний
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

    // Класс Player для видео через HTML5 (без YouTube API)
    var Player = function(object, video) {
        var self = this;
        
        this.paused = false;
        this.display = false;
        this.ended = false;
        this.loaded = false;
        this.timer = null;
        this.listener = Lampa.Subscribe();
        this.videoUrl = null;
        this.currentInstance = 0;
        
        this.html = $('\
            <div class="cardify-trailer">\
                <div class="cardify-trailer__player">\
                    <video class="cardify-trailer__video" playsinline></video>\
                    <div class="cardify-trailer__loading">\
                        <div class="cardify-trailer__spinner"></div>\
                    </div>\
                </div>\
                <div class="cardify-trailer__controlls">\
                    <div class="cardify-trailer__title"></div>\
                    <div class="cardify-trailer__remote">\
                        <div class="cardify-trailer__remote-icon">\
                            <svg width="37" height="37" viewBox="0 0 37 37" fill="none" xmlns="http://www.w3.org/2000/svg">\
                                <path d="M32.5196 7.22042L26.7992 12.9408C27.8463 14.5217 28.4561 16.4175 28.4561 18.4557C28.4561 20.857 27.6098 23.0605 26.1991 24.7844L31.8718 30.457C34.7226 27.2724 36.4561 23.0667 36.4561 18.4561C36.4561 14.2059 34.983 10.2998 32.5196 7.22042Z" fill="white" fill-opacity="0.28"/>\
                                <path d="M29.6917 32.5196L23.971 26.7989C22.3901 27.846 20.4943 28.4557 18.4561 28.4557C16.4179 28.4557 14.5221 27.846 12.9412 26.7989L7.22042 32.5196C10.2998 34.983 14.2059 36.4561 18.4561 36.4561C22.7062 36.4561 26.6123 34.983 29.6917 32.5196Z" fill="white" fill-opacity="0.28"/>\
                                <path d="M5.04033 30.4571L10.7131 24.7844C9.30243 23.0605 8.4561 20.857 8.4561 18.4557C8.4561 16.4175 9.06588 14.5217 10.113 12.9408L4.39251 7.22037C1.9291 10.2998 0.456055 14.2059 0.456055 18.4561C0.456054 23.0667 2.18955 27.2724 5.04033 30.4571Z" fill="white" fill-opacity="0.28"/>\
                                <path d="M6.45507 5.04029C9.63973 2.18953 13.8455 0.456055 18.4561 0.456055C23.0667 0.456054 27.2724 2.18955 30.4571 5.04034L24.7847 10.7127C23.0609 9.30207 20.8573 8.45575 18.4561 8.45575C16.0549 8.45575 13.8513 9.30207 12.1275 10.7127L6.45507 5.04029Z" fill="white" fill-opacity="0.28"/>\
                                <circle cx="18.4565" cy="18.4561" r="7" fill="white"/>\
                            </svg>\
                        </div>\
                        <div class="cardify-trailer__remote-text">' + Lampa.Lang.translate('cardify_enable_sound') + '</div>\
                    </div>\
                </div>\
            </div>\
        ');

        this.videoElement = this.html.find('.cardify-trailer__video')[0];
        this.loadingElement = this.html.find('.cardify-trailer__loading');

        // Получаем прямую ссылку на видео через прокси
        this.getVideoUrl = function(videoId, callback) {
            var instance = Lampa.Storage.get('cardify_proxy_instance', '') || PROXY_INSTANCES[0];
            
            // Пробуем получить видео через API инстанса
            var tryInstance = function(url) {
                self.loadingElement.show();
                
                // Для Piped
                if (url.indexOf('piped') !== -1) {
                    $.ajax({
                        url: url + '/streams/' + videoId,
                        timeout: 10000,
                        success: function(data) {
                            if (data && data.videoStreams && data.videoStreams.length) {
                                // Сортируем по качеству и берём лучшее MP4
                                var streams = data.videoStreams.filter(function(s) {
                                    return s.mimeType && s.mimeType.indexOf('video/mp4') !== -1;
                                }).sort(function(a, b) {
                                    return (b.height || 0) - (a.height || 0);
                                });
                                
                                if (streams.length) {
                                    callback(streams[0].url);
                                    return;
                                }
                            }
                            
                            // Если есть HLS
                            if (data && data.hls) {
                                callback(data.hls);
                                return;
                            }
                            
                            callback(null);
                        },
                        error: function() {
                            callback(null);
                        }
                    });
                } 
                // Для Invidious
                else {
                    $.ajax({
                        url: url + '/api/v1/videos/' + videoId,
                        timeout: 10000,
                        success: function(data) {
                            if (data && data.formatStreams && data.formatStreams.length) {
                                // Берём лучшее качество
                                var streams = data.formatStreams.sort(function(a, b) {
                                    return (parseInt(b.qualityLabel) || 0) - (parseInt(a.qualityLabel) || 0);
                                });
                                
                                callback(streams[0].url);
                                return;
                            }
                            
                            if (data && data.adaptiveFormats) {
                                var videos = data.adaptiveFormats.filter(function(f) {
                                    return f.type && f.type.indexOf('video/mp4') !== -1;
                                }).sort(function(a, b) {
                                    return (parseInt(b.qualityLabel) || 0) - (parseInt(a.qualityLabel) || 0);
                                });
                                
                                if (videos.length) {
                                    callback(videos[0].url);
                                    return;
                                }
                            }
                            
                            callback(null);
                        },
                        error: function() {
                            callback(null);
                        }
                    });
                }
            };

            tryInstance(instance);
        };

        // Инициализация видео
        this.initVideo = function() {
            self.getVideoUrl(video.id, function(url) {
                self.loadingElement.hide();
                
                if (url) {
                    self.videoUrl = url;
                    self.videoElement.src = url;
                    self.videoElement.muted = true;
                    self.videoElement.load();
                    
                    self.loaded = true;
                    self.listener.send('loaded');
                } else {
                    self.loaded = false;
                    self.listener.send('error');
                }
            });
        };

        // События видео
        $(this.videoElement).on('play playing', function() {
            self.paused = false;
            clearInterval(self.timer);
            
            self.timer = setInterval(function() {
                var left = self.videoElement.duration - self.videoElement.currentTime;
                var toend = 13;
                var fade = 5;

                if (left <= toend + fade) {
                    var vol = 1 - (toend + fade - left) / fade;
                    self.videoElement.volume = Math.max(0, vol);

                    if (left <= toend) {
                        clearInterval(self.timer);
                        self.listener.send('ended');
                    }
                }
            }, 100);

            self.listener.send('play');

            if (window.cardify_fist_unmute) self.unmute();
        });

        $(this.videoElement).on('pause', function() {
            self.paused = true;
            clearInterval(self.timer);
            self.listener.send('paused');
        });

        $(this.videoElement).on('ended', function() {
            self.listener.send('ended');
        });

        $(this.videoElement).on('error', function() {
            self.loaded = false;
            self.listener.send('error');
        });

        // Запускаем загрузку
        this.initVideo();

        this.play = function() {
            try { 
                var playPromise = this.videoElement.play();
                if (playPromise !== undefined) {
                    playPromise.catch(function(e) {
                        console.log('Cardify: Autoplay prevented', e);
                    });
                }
            } catch (e) {}
        };

        this.pause = function() {
            try { this.videoElement.pause(); } catch (e) {}
        };

        this.unmute = function() {
            try {
                this.videoElement.muted = false;
                this.videoElement.volume = 1;
                this.html.find('.cardify-trailer__remote').remove();
                window.cardify_fist_unmute = true;
            } catch (e) {}
        };

        this.show = function() {
            this.html.addClass('display');
            this.display = true;
        };

        this.hide = function() {
            this.html.removeClass('display');
            this.display = false;
        };

        this.render = function() {
            return this.html;
        };

        this.destroy = function() {
            this.loaded = false;
            this.display = false;
            try { 
                this.videoElement.pause();
                this.videoElement.src = '';
                this.videoElement.load();
            } catch (e) {}
            clearInterval(this.timer);
            this.html.remove();
        };
    };

    // Класс Trailer
    var Trailer = function(object, video) {
        var self = this;
        
        object.activity.trailer_ready = true;
        
        this.object = object;
        this.video = video;
        this.player = null;
        this.background = this.object.activity.render().find('.full-start__background');
        this.startblock = this.object.activity.render().find('.cardify');
        this.head = $('.head');
        this.timelauch = 1200;
        this.firstlauch = false;
        this.timer_load = null;
        this.timer_show = null;
        this.timer_anim = null;

        this.state = new State({
            state: 'start',
            transitions: {
                start: function(state) {
                    clearTimeout(self.timer_load);
                    if (self.player.display) {
                        state.dispath('play');
                    } else if (self.player.loaded) {
                        self.animate();
                        self.timer_load = setTimeout(function() {
                            state.dispath('load');
                        }, self.timelauch);
                    }
                },
                load: function(state) {
                    if (self.player.loaded && Lampa.Controller.enabled().name == 'full_start' && self.same()) {
                        state.dispath('play');
                    }
                },
                play: function() {
                    self.player.play();
                },
                toggle: function(state) {
                    clearTimeout(self.timer_load);

                    if (Lampa.Controller.enabled().name == 'cardify_trailer') {
                        // do nothing
                    } else if (Lampa.Controller.enabled().name == 'full_start' && self.same()) {
                        state.start();
                    } else if (self.player.display) {
                        state.dispath('hide');
                    }
                },
                hide: function() {
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
                var left = Date.now() - started;
                if (left > self.timelauch) clearInterval(self.timer_anim);
                loader.width(Math.round(left / self.timelauch * 100) + '%');
            }, 100);
        };

        this.preview = function() {
            var preview = $('\
                <div class="cardify-preview">\
                    <div>\
                        <img class="cardify-preview__img" />\
                        <div class="cardify-preview__line one"></div>\
                        <div class="cardify-preview__line two"></div>\
                        <div class="cardify-preview__loader"></div>\
                    </div>\
                </div>\
            ');

            // Используем прокси для превью
            var proxyInstance = Lampa.Storage.get('cardify_proxy_instance', '') || PROXY_INSTANCES[0];
            var imgUrl = proxyInstance + '/vi/' + this.video.id + '/mqdefault.jpg';
            
            // Fallback на оригинальный YouTube если прокси не работает
            Lampa.Utils.imgLoad($('img', preview), imgUrl, function() {
                $('img', preview).addClass('loaded');
            }, function() {
                // Fallback
                $('img', preview).attr('src', 'https://img.youtube.com/vi/' + self.video.id + '/mqdefault.jpg').addClass('loaded');
            });

            this.object.activity.render().find('.cardify__right').append(preview);
        };

        this.controll = function() {
            var out = function() {
                self.state.dispath('hide');
                Lampa.Controller.toggle('full_start');
            };

            Lampa.Controller.add('cardify_trailer', {
                toggle: function() {
                    Lampa.Controller.clear();
                },
                enter: function() {
                    self.player.unmute();
                },
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
            // Events
            var toggle = function(e) {
                self.state.dispath('toggle');
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

            // Player
            this.player = new Player(this.object, this.video);

            this.player.listener.follow('loaded', function() {
                self.preview();
                self.state.start();
            });

            this.player.listener.follow('play', function() {
                clearTimeout(self.timer_show);

                if (!self.firstlauch) {
                    self.firstlauch = true;
                    self.timelauch = 5000;
                }

                self.timer_show = setTimeout(function() {
                    self.player.show();
                    self.background.addClass('nodisplay');
                    self.startblock.addClass('nodisplay');
                    self.head.addClass('nodisplay');
                    self.controll();
                }, 500);
            });

            this.player.listener.follow('ended,error', function() {
                self.state.dispath('hide');

                if (Lampa.Controller.enabled().name !== 'full_start') {
                    Lampa.Controller.toggle('full_start');
                }

                self.object.activity.render().find('.cardify-preview').remove();
                setTimeout(remove, 300);
            });

            this.object.activity.render().find('.activity__body').prepend(this.player.render());

            // Start
            this.state.start();
        };

        this.destroy = function() {
            clearTimeout(this.timer_load);
            clearTimeout(this.timer_show);
            clearInterval(this.timer_anim);
            this.player.destroy();
        };

        // Автозапуск
        this.start();
    };

    function startPlugin() {
        // Добавляем переводы
        Lampa.Lang.add({
            cardify_enable_sound: {
                ru: 'Включить звук',
                en: 'Enable sound',
                uk: 'Увімкнути звук',
                be: 'Уключыць гук',
                zh: '启用声音',
                pt: 'Ativar som',
                bg: 'Включване на звук'
            },
            cardify_enable_trailer: {
                ru: 'Показывать трейлер',
                en: 'Show trailer',
                uk: 'Показувати трейлер',
                be: 'Паказваць трэйлер',
                zh: '显示预告片',
                pt: 'Mostrar trailer',
                bg: 'Показване на трейлър'
            },
            cardify_proxy_instance: {
                ru: 'Прокси-сервер (Invidious/Piped)',
                en: 'Proxy server (Invidious/Piped)',
                uk: 'Проксі-сервер (Invidious/Piped)',
                be: 'Проксі-сервер (Invidious/Piped)',
                zh: '代理服务器 (Invidious/Piped)',
                pt: 'Servidor proxy (Invidious/Piped)',
                bg: 'Прокси сървър (Invidious/Piped)'
            },
            cardify_proxy_description: {
                ru: 'Введите адрес Invidious или Piped инстанса',
                en: 'Enter Invidious or Piped instance URL',
                uk: 'Введіть адресу Invidious або Piped інстансу',
                be: 'Увядзіце адрас Invidious ці Piped інстансу',
                zh: '输入 Invidious 或 Piped 实例地址',
                pt: 'Digite o URL da instância Invidious ou Piped',
                bg: 'Въведете URL на Invidious или Piped инстанция'
            }
        });

        // Добавляем шаблон карточки
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
                            <div class="cardify__details">\
                                <div class="full-start-new__details"></div>\
                            </div>\
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
                                        <path d="M37.208 10.9742C37.1364 10.8013 37.0314 10.6441 36.899 10.5117C36.7666 10.3794 36.6095 10.2744 36.4365 10.2028L12.0658 0.108375C11.7166 -0.0361828 11.3242 -0.0361227 10.9749 0.108542C10.6257 0.253206 10.3482 0.530634 10.2034 0.879836L0.108666 25.2507C0.0369593 25.4236 3.37953e-05 25.609 2.3187e-08 25.7962C-3.37489e-05 25.9834 0.0368249 26.1688 0.108469 26.3418C0.180114 26.5147 0.28514 26.6719 0.417545 26.8042C0.54995 26.9366 0.707139 27.0416 0.880127 27.1131L17.2452 33.8917C17.5945 34.0361 17.9869 34.0361 18.3362 33.8917L29.6574 29.2017C29.8304 29.1301 29.9875 29.0251 30.1199 28.8928C30.2523 28.7604 30.3573 28.6032 30.4289 28.4303L37.2078 12.065C37.2795 11.8921 37.3164 11.7068 37.3164 11.5196C37.3165 11.3325 37.2796 11.1471 37.208 10.9742ZM20.425 29.9407L21.8784 26.4316L25.3873 27.885L20.425 29.9407ZM28.3407 26.0222L21.6524 23.252C21.3031 23.1075 20.9107 23.1076 20.5615 23.2523C20.2123 23.3969 19.9348 23.6743 19.79 24.0235L17.0194 30.7123L3.28783 25.0247L12.2918 3.28773L34.0286 12.2912L28.3407 26.0222Z" fill="currentColor"/>\
                                        <path d="M25.3493 16.976L24.258 14.3423L16.959 17.3666L15.7196 14.375L13.0859 15.4659L15.4161 21.0916L25.3493 16.976Z" fill="currentColor"/>\
                                    </svg>\
                                    <span>#{title_reactions}</span>\
                                </div>\
                                <div class="full-start__button selector button--subscribe hide">\
                                    <svg width="25" height="30" viewBox="0 0 25 30" fill="none" xmlns="http://www.w3.org/2000/svg">\
                                        <path d="M6.01892 24C6.27423 27.3562 9.07836 30 12.5 30C15.9216 30 18.7257 27.3562 18.981 24H15.9645C15.7219 25.6961 14.2632 27 12.5 27C10.7367 27 9.27804 25.6961 9.03542 24H6.01892Z" fill="currentColor"/>\
                                        <path d="M3.81972 14.5957V10.2679C3.81972 5.41336 7.7181 1.5 12.5 1.5C17.2819 1.5 21.1803 5.41336 21.1803 10.2679V14.5957C21.1803 15.8462 21.5399 17.0709 22.2168 18.1213L23.0727 19.4494C24.2077 21.2106 22.9392 23.5 20.9098 23.5H4.09021C2.06084 23.5 0.792282 21.2106 1.9273 19.4494L2.78317 18.1213C3.46012 17.0709 3.81972 15.8462 3.81972 14.5957Z" stroke="currentColor" stroke-width="2.5"/>\
                                    </svg>\
                                    <span>#{title_subscribe}</span>\
                                </div>\
                                <div class="full-start__button selector button--options">\
                                    <svg width="38" height="10" viewBox="0 0 38 10" fill="none" xmlns="http://www.w3.org/2000/svg">\
                                        <circle cx="4.88968" cy="4.98563" r="4.75394" fill="currentColor"/>\
                                        <circle cx="18.9746" cy="4.98563" r="4.75394" fill="currentColor"/>\
                                        <circle cx="33.0596" cy="4.98563" r="4.75394" fill="currentColor"/>\
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
                            <path fill-rule="evenodd" clip-rule="evenodd" d="M71.2555 2.08955C74.6975 3.2397 77.4083 6.62804 78.3283 10.9306C80 18.7291 80 35 80 35C80 35 80 51.2709 78.3283 59.0694C77.4083 63.372 74.6975 66.7603 71.2555 67.9104C65.0167 70 40 70 40 70C40 70 14.9833 70 8.74453 67.9104C5.3025 66.7603 2.59172 63.372 1.67172 59.0694C0 51.2709 0 35 0 35C0 35 0 18.7291 1.67172 10.9306C2.59172 6.62804 5.3025 3.2395 8.74453 2.08955C14.9833 0 40 0 40 0C40 0 65.0167 0 71.2555 2.08955ZM55.5909 35.0004L29.9773 49.5714V20.4286L55.5909 35.0004Z" fill="currentColor"></path>\
                        </svg>\
                        <span>#{full_trailers}</span>\
                    </div>\
                </div>\
            </div>\
        ');

        // CSS стили с УВЕЛИЧЕННЫМ ЛОГОТИПОМ/НАЗВАНИЕМ
        var style = '\
            <style>\
            .cardify{-webkit-transition:all .3s;-o-transition:all .3s;-moz-transition:all .3s;transition:all .3s}\
            .cardify .full-start-new__body{height:80vh}\
            .cardify .full-start-new__right{display:-webkit-box;display:-webkit-flex;display:-moz-box;display:-ms-flexbox;display:flex;-webkit-box-align:end;-webkit-align-items:flex-end;-moz-box-align:end;-ms-flex-align:end;align-items:flex-end}\
            .cardify .full-start-new__title{text-shadow:0 0 .1em rgba(0,0,0,0.3);font-size:4.5em !important;line-height:1.1 !important}\
            .cardify .full-start-new__head{margin-bottom:0.5em}\
            /* Увеличенный логотип для плагина logo */\
            .cardify .full-start-new__title img,\
            .cardify .full-start-new__head img,\
            .cardify .full-start__title-img,\
            .cardify .logo-image,\
            .cardify img.full--logo{\
                max-height: 12em !important;\
                max-width: 80% !important;\
                height: auto !important;\
                width: auto !important;\
                object-fit: contain !important;\
            }\
            /* Если логотип в заголовке */\
            .cardify .full-start-new__head .full-start__title-img,\
            .cardify .full-start-new__head .logo-image{\
                max-height: 10em !important;\
            }\
            .cardify__left{-webkit-box-flex:1;-webkit-flex-grow:1;-moz-box-flex:1;-ms-flex-positive:1;flex-grow:1}\
            .cardify__right{display:-webkit-box;display:-webkit-flex;display:-moz-box;display:-ms-flexbox;display:flex;-webkit-box-align:center;-webkit-align-items:center;-moz-box-align:center;-ms-flex-align:center;align-items:center;-webkit-flex-shrink:0;-ms-flex-negative:0;flex-shrink:0;position:relative}\
            .cardify__details{display:-webkit-box;display:-webkit-flex;display:-moz-box;display:-ms-flexbox;display:flex}\
            .cardify .full-start-new__reactions{margin:0;margin-right:-2.8em}\
            .cardify .full-start-new__reactions:not(.focus){margin:0}\
            .cardify .full-start-new__reactions:not(.focus)>div:not(:first-child){display:none}\
            .cardify .full-start-new__reactions:not(.focus) .reaction{position:relative}\
            .cardify .full-start-new__reactions:not(.focus) .reaction__count{position:absolute;top:28%;left:95%;font-size:1.2em;font-weight:500}\
            .cardify .full-start-new__rate-line{margin:0;margin-left:3.5em}\
            .cardify .full-start-new__rate-line>*:last-child{margin-right:0 !important}\
            .cardify__background{left:0}\
            .cardify__background.loaded:not(.dim){opacity:1}\
            .cardify__background.nodisplay{opacity:0 !important}\
            .cardify.nodisplay{-webkit-transform:translate3d(0,50%,0);-moz-transform:translate3d(0,50%,0);transform:translate3d(0,50%,0);opacity:0}\
            .cardify-trailer{opacity:0;-webkit-transition:opacity .3s;-o-transition:opacity .3s;-moz-transition:opacity .3s;transition:opacity .3s;position:fixed;top:0;left:0;right:0;bottom:0;z-index:999}\
            .cardify-trailer__player{background-color:#000;position:fixed;top:0;left:0;right:0;bottom:0;display:-webkit-box;display:-webkit-flex;display:-moz-box;display:-ms-flexbox;display:flex;-webkit-box-align:center;-webkit-align-items:center;-moz-box-align:center;-ms-flex-align:center;align-items:center;justify-content:center}\
            .cardify-trailer__video{width:100%;height:100%;object-fit:contain;background:#000}\
            .cardify-trailer__loading{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}\
            .cardify-trailer__spinner{width:50px;height:50px;border:4px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:cardify-spin 1s linear infinite}\
            @keyframes cardify-spin{to{transform:rotate(360deg)}}\
            .cardify-trailer__controlls{position:fixed;left:1.5em;right:1.5em;bottom:1.5em;display:-webkit-box;display:-webkit-flex;display:-moz-box;display:-ms-flexbox;display:flex;-webkit-box-align:end;-webkit-align-items:flex-end;-moz-box-align:end;-ms-flex-align:end;align-items:flex-end;-webkit-transform:translate3d(0,-100%,0);-moz-transform:translate3d(0,-100%,0);transform:translate3d(0,-100%,0);opacity:0;-webkit-transition:all .3s;-o-transition:all .3s;-moz-transition:all .3s;transition:all .3s}\
            .cardify-trailer__title{-webkit-box-flex:1;-webkit-flex-grow:1;-moz-box-flex:1;-ms-flex-positive:1;flex-grow:1;padding-right:5em;font-size:4em;font-weight:600;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;line-clamp:1;-webkit-box-orient:vertical;line-height:1.4}\
            .cardify-trailer__remote{-webkit-flex-shrink:0;-ms-flex-negative:0;flex-shrink:0;display:-webkit-box;display:-webkit-flex;display:-moz-box;display:-ms-flexbox;display:flex;-webkit-box-align:center;-webkit-align-items:center;-moz-box-align:center;-ms-flex-align:center;align-items:center}\
            .cardify-trailer__remote-icon{-webkit-flex-shrink:0;-ms-flex-negative:0;flex-shrink:0;width:2.5em;height:2.5em}\
            .cardify-trailer__remote-icon svg{width:100%;height:100%}\
            .cardify-trailer__remote-text{margin-left:1em}\
            .cardify-trailer.display{opacity:1}\
            .cardify-trailer.display .cardify-trailer__controlls{-webkit-transform:translate3d(0,0,0);-moz-transform:translate3d(0,0,0);transform:translate3d(0,0,0);opacity:1}\
            .cardify-preview{position:absolute;bottom:100%;right:0;-webkit-border-radius:.3em;-moz-border-radius:.3em;border-radius:.3em;width:6em;height:4em;display:-webkit-box;display:-webkit-flex;display:-moz-box;display:-ms-flexbox;display:flex;background-color:#000;overflow:hidden}\
            .cardify-preview>div{position:relative;width:100%;height:100%}\
            .cardify-preview__img{opacity:0;position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;-webkit-transition:opacity .2s;-o-transition:opacity .2s;-moz-transition:opacity .2s;transition:opacity .2s}\
            .cardify-preview__img.loaded{opacity:1}\
            .cardify-preview__loader{position:absolute;left:50%;bottom:0;-webkit-transform:translate3d(-50%,0,0);-moz-transform:translate3d(-50%,0,0);transform:translate3d(-50%,0,0);height:.2em;-webkit-border-radius:.2em;-moz-border-radius:.2em;border-radius:.2em;background-color:#fff;width:0;-webkit-transition:width .1s linear;-o-transition:width .1s linear;-moz-transition:width .1s linear;transition:width .1s linear}\
            .cardify-preview__line{position:absolute;height:.8em;left:0;width:100%;background-color:#000}\
            .cardify-preview__line.one{top:0}\
            .cardify-preview__line.two{bottom:0}\
            .head.nodisplay{-webkit-transform:translate3d(0,-100%,0);-moz-transform:translate3d(0,-100%,0);transform:translate3d(0,-100%,0)}\
            body:not(.menu--open) .cardify__background{-webkit-mask-image:linear-gradient(to bottom,white 50%,rgba(255,255,255,0) 100%);mask-image:linear-gradient(to bottom,white 50%,rgba(255,255,255,0) 100%)}\
            </style>\
        ';
        
        Lampa.Template.add('cardify_css', style);
        $('body').append(Lampa.Template.get('cardify_css', {}, true));

        // Иконка настроек
        var icon = '<svg width="36" height="28" viewBox="0 0 36 28" fill="none" xmlns="http://www.w3.org/2000/svg">\
            <rect x="1.5" y="1.5" width="33" height="25" rx="3.5" stroke="white" stroke-width="3"/>\
            <rect x="5" y="14" width="17" height="4" rx="2" fill="white"/>\
            <rect x="5" y="20" width="10" height="3" rx="1.5" fill="white"/>\
            <rect x="25" y="20" width="6" height="3" rx="1.5" fill="white"/>\
        </svg>';

        Lampa.SettingsApi.addComponent({
            component: 'cardify',
            icon: icon,
            name: 'Cardify Free'
        });

        Lampa.SettingsApi.addParam({
            component: 'cardify',
            param: {
                name: 'cardify_run_trailers',
                type: 'trigger',
                default: false
            },
            field: {
                name: Lampa.Lang.translate('cardify_enable_trailer')
            }
        });

        // Настройка прокси-сервера
        Lampa.SettingsApi.addParam({
            component: 'cardify',
            param: {
                name: 'cardify_proxy_instance',
                type: 'select',
                values: {
                    'https://inv.nadeko.net': 'inv.nadeko.net',
                    'https://invidious.nerdvpn.de': 'invidious.nerdvpn.de',
                    'https://invidious.jing.rocks': 'invidious.jing.rocks',
                    'https://piped.video': 'piped.video',
                    'https://vid.puffyan.us': 'vid.puffyan.us',
                    'https://yewtu.be': 'yewtu.be'
                },
                default: 'https://inv.nadeko.net'
            },
            field: {
                name: Lampa.Lang.translate('cardify_proxy_instance'),
                description: Lampa.Lang.translate('cardify_proxy_description')
            }
        });

        // Функция получения видео трейлера
        function getVideo(data) {
            if (data.videos && data.videos.results.length) {
                var items = [];
                
                data.videos.results.forEach(function(element) {
                    items.push({
                        title: Lampa.Utils.shortText(element.name, 50),
                        id: element.key,
                        code: element.iso_639_1,
                        time: new Date(element.published_at).getTime(),
                        url: 'https://www.youtube.com/watch?v=' + element.key,
                        img: 'https://img.youtube.com/vi/' + element.key + '/mqdefault.jpg'
                    });
                });

                items.sort(function(a, b) {
                    return a.time > b.time ? -1 : a.time < b.time ? 1 : 0;
                });

                var my_lang = items.filter(function(n) {
                    return n.code == Lampa.Storage.field('tmdb_lang');
                });

                var en_lang = items.filter(function(n) {
                    return n.code == 'en' && my_lang.indexOf(n) == -1;
                });

                var al_lang = [];

                if (my_lang.length) {
                    al_lang = al_lang.concat(my_lang);
                }

                al_lang = al_lang.concat(en_lang);

                if (al_lang.length) return al_lang[0];
            }
            return null;
        }

        // Слушаем событие загрузки карточки фильма
        Lampa.Listener.follow('full', function(e) {
            if (e.type == 'complite') {
                // Добавляем класс для фона
                e.object.activity.render().find('.full-start__background').addClass('cardify__background');

                // Проверяем настройку
                if (!Lampa.Storage.field('cardify_run_trailers')) return;

                var trailer = getVideo(e.data);

                if (Lampa.Manifest && Lampa.Manifest.app_digital >= 220) {
                    if (Lampa.Activity.active().activity === e.object.activity) {
                        if (trailer) new Trailer(e.object, trailer);
                    } else {
                        var follow = function(a) {
                            if (a.type == 'start' && a.object.activity === e.object.activity && !e.object.activity.trailer_ready) {
                                Lampa.Listener.remove('activity', follow);
                                if (trailer) new Trailer(e.object, trailer);
                            }
                        };

                        Lampa.Listener.follow('activity', follow);
                    }
                }
            }
        });
    }

    // Запуск плагина
    if (window.appready) {
        startPlugin();
    } else {
        Lampa.Listener.follow('app', function(e) {
            if (e.type == 'ready') startPlugin();
        });
    }

})();
