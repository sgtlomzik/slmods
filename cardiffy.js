(function () {
    'use strict';

    /**
     * Cardify Free Plugin
     * @version 1.5.0
     * 
     * Changelog:
     * 1.5.0 - Трейлер на фоне карточки (как Netflix), исправлен шаблон
     */
    var PLUGIN_VERSION = '1.5.0';

    var DEBUG = true;
    
    function log() {
        if (DEBUG) {
            var args = Array.prototype.slice.call(arguments);
            args.unshift('[Cardify v' + PLUGIN_VERSION + ']');
            console.log.apply(console, args);
        }
    }

    log('Загрузка плагина...');

    // ==================== ITUNES ====================
    var iTunesTrailer = (function() {
        function load(movie, isTv, callback) {
            var title = movie.original_title || movie.original_name || movie.title || movie.name || '';
            
            if (!title || !/[a-z]{2}/i.test(title)) {
                callback(null);
                return;
            }
            
            var year = (movie.release_date || movie.first_air_date || '').substring(0, 4);
            var cacheKey = 'cardify_itunes_' + movie.id;
            var cached = sessionStorage.getItem(cacheKey);
            
            if (cached) {
                var data = JSON.parse(cached);
                callback(data.url ? data : null);
                return;
            }
            
            var url = 'https://itunes.apple.com/search?term=' + 
                encodeURIComponent(title).replace(/%20/g, '+') +
                '&media=' + (isTv ? 'tvShow' : 'movie') + '&limit=10';
            
            log('iTunes запрос:', url);
            
            $.ajax({
                url: url,
                dataType: 'json',
                timeout: 10000,
                success: function(data) {
                    log('iTunes ответ:', data);
                    var found = null;
                    
                    if (data && data.results) {
                        for (var i = 0; i < data.results.length; i++) {
                            var r = data.results[i];
                            if (!r.previewUrl) continue;
                            if (year && r.releaseDate && r.releaseDate.substring(0, 4) !== year) continue;
                            found = { title: r.trackName || title, url: r.previewUrl };
                            break;
                        }
                    }
                    
                    sessionStorage.setItem(cacheKey, JSON.stringify(found || { url: null }));
                    callback(found);
                },
                error: function() {
                    sessionStorage.setItem(cacheKey, JSON.stringify({ url: null }));
                    callback(null);
                }
            });
        }
        
        return { load: load };
    })();

    // ==================== ORIGINAL TITLE ====================
    var OriginalTitle = (function() {
        var cache = Lampa.Storage.get("cardify_titles") || {};

        async function fetch(card) {
            var orig = card.original_title || card.original_name || '';
            if (cache[card.id]) return { original: orig, ...cache[card.id] };

            try {
                var type = card.first_air_date ? "tv" : "movie";
                var data = await new Promise((res, rej) => {
                    Lampa.Api.sources.tmdb.get(type + "/" + card.id + "?append_to_response=translations", {}, res, rej);
                });
                
                var tr = data.translations?.translations || [];
                var ru = tr.find(t => t.iso_3166_1 === "RU" || t.iso_639_1 === "ru")?.data;
                var en = tr.find(t => t.iso_3166_1 === "US" || t.iso_639_1 === "en")?.data;
                
                cache[card.id] = { 
                    ru: ru?.title || ru?.name, 
                    en: en?.title || en?.name 
                };
                Lampa.Storage.set("cardify_titles", cache);
            } catch (e) {}

            return { original: orig, ...cache[card.id] };
        }

        function render(container, titles) {
            container.find('.cardify-original-titles').remove();
            var lang = Lampa.Storage.get("language") || 'ru';
            var items = [];
            
            if (titles.original) items.push({ title: titles.original, label: 'Original' });
            if (titles.en && lang !== 'en' && titles.en !== titles.original) items.push({ title: titles.en, label: 'EN' });
            if (titles.ru && lang !== 'ru') items.push({ title: titles.ru, label: 'RU' });

            if (!items.length) return;

            var html = '<div class="cardify-original-titles">' + items.map(function(i) {
                return '<div class="cardify-original-titles__item"><span>' + i.title + '</span><span class="cardify-original-titles__label">' + i.label + '</span></div>';
            }).join('') + '</div>';

            container.find('.full-start-new__buttons').before(html);
        }

        return { fetch: fetch, render: render };
    })();

    // ==================== BACKGROUND TRAILER ====================
    var BackgroundTrailer = function(render, video) {
        var self = this;
        this.destroyed = false;
        
        log('BackgroundTrailer создан:', video.url);
        
        // Создаём видео элемент для фона
        this.html = $('\
            <div class="cardify-bg-trailer">\
                <video class="cardify-bg-trailer__video" playsinline muted loop></video>\
                <div class="cardify-bg-trailer__overlay"></div>\
            </div>\
        ');
        
        this.videoElement = this.html.find('video')[0];
        this.background = render.find('.full-start__background');
        
        // Вставляем после фонового изображения
        this.background.after(this.html);
        
        // Загружаем видео
        this.videoElement.src = video.url;
        
        $(this.videoElement).on('canplay', function() {
            if (self.destroyed) return;
            log('Фоновый трейлер готов');
            
            // Плавно показываем видео и скрываем статичный фон
            self.html.addClass('cardify-bg-trailer--visible');
            self.background.addClass('cardify-bg-trailer--hidden');
            
            self.videoElement.play().catch(function(e) {
                log('Autoplay заблокирован:', e);
            });
        });
        
        $(this.videoElement).on('error', function() {
            log('Ошибка загрузки фонового трейлера');
            self.destroy();
        });
        
        this.destroy = function() {
            this.destroyed = true;
            this.background.removeClass('cardify-bg-trailer--hidden');
            try {
                this.videoElement.pause();
                this.videoElement.src = '';
            } catch(e) {}
            this.html.remove();
        };
    };

    // ==================== PLUGIN START ====================
    function startPlugin() {
        log('Инициализация...');

        Lampa.Lang.add({
            cardify_enable_trailer: {
                ru: 'Фоновый трейлер', en: 'Background trailer', uk: 'Фоновий трейлер'
            },
            cardify_show_original_title: {
                ru: 'Оригинальное название', en: 'Original title', uk: 'Оригінальна назва'
            }
        });

        // === ШАБЛОН КАРТОЧКИ ===
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
                            <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="2.5"/>\
                            <circle cx="11" cy="13" r="2" fill="currentColor"/>\
                            <circle cx="21" cy="13" r="2" fill="currentColor"/>\
                            <path d="M10 20c1.5 2.5 3.5 4 6 4s4.5-1.5 6-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>\
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
                            <circle cx="5" cy="5" r="4.5" fill="currentColor"/>\
                            <circle cx="19" cy="5" r="4.5" fill="currentColor"/>\
                            <circle cx="33" cy="5" r="4.5" fill="currentColor"/>\
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
        <div class="full-start__button view--torrent hide"></div>\
        <div class="full-start__button selector view--trailer"></div>\
    </div>\
</div>');

        // === CSS ===
        var style = $('<style id="cardify-styles">\
            /* ОСНОВА */\
            .cardify{transition:all .3s}\
            .cardify .full-start-new__body{height:80vh}\
            .cardify .full-start-new__right{display:flex;align-items:flex-end}\
            .cardify .full-start-new__head{margin-bottom:0.3em}\
            \
            /* ЛОГОТИП */\
            .cardify .full-start-new__title{\
                font-size:3.5em !important;\
                line-height:1.1 !important;\
                text-shadow:0 2px 10px rgba(0,0,0,0.7);\
                margin-bottom:0.2em;\
            }\
            .cardify .full-start-new__title img,\
            .cardify .full-start-new__head img,\
            .cardify .full-start__title-img,\
            .cardify img.full--logo{\
                max-height:6em !important;\
                max-width:70% !important;\
                height:auto !important;\
                width:auto !important;\
            }\
            \
            /* ДЕТАЛИ */\
            .cardify .full-start-new__details{\
                margin-bottom:0.6em;\
                font-size:1.3em;\
                opacity:0.8;\
            }\
            \
            /* ОРИГИНАЛЬНЫЕ НАЗВАНИЯ */\
            .cardify-original-titles{\
                margin-bottom:0.8em;\
                display:flex;\
                flex-direction:column;\
                gap:0.2em;\
            }\
            .cardify-original-titles__item{\
                display:flex;\
                align-items:center;\
                gap:0.5em;\
                font-size:1.2em;\
                opacity:0.7;\
            }\
            .cardify-original-titles__label{\
                font-size:0.6em;\
                padding:0.1em 0.3em;\
                background:rgba(255,255,255,0.15);\
                border-radius:3px;\
                text-transform:uppercase;\
            }\
            \
            /* LAYOUT */\
            .cardify__left{flex-grow:1;max-width:65%}\
            .cardify__right{display:flex;flex-direction:column;align-items:flex-end}\
            \
            /* РЕАКЦИИ */\
            .cardify .full-start-new__reactions{margin:0 0 1em 0}\
            .cardify .full-start-new__reactions:not(.focus) > div > *:not(:first-child){display:none}\
            .cardify .full-start-new__reactions .reaction__count{\
                margin-left:0.3em;\
            }\
            .cardify .full-start-new__rate-line{margin:0}\
            \
            /* ФОНОВЫЙ ТРЕЙЛЕР */\
            .cardify-bg-trailer{\
                position:absolute;\
                top:0;left:0;right:0;bottom:0;\
                z-index:0;\
                opacity:0;\
                transition:opacity 1s ease;\
            }\
            .cardify-bg-trailer--visible{\
                opacity:1;\
            }\
            .cardify-bg-trailer__video{\
                width:100%;\
                height:100%;\
                object-fit:cover;\
            }\
            .cardify-bg-trailer__overlay{\
                position:absolute;\
                top:0;left:0;right:0;bottom:0;\
                background:linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0.5) 100%);\
            }\
            .cardify-bg-trailer--hidden{\
                opacity:0 !important;\
            }\
            \
            /* ФОН */\
            .cardify__background{left:0;transition:opacity 1s ease}\
            body:not(.menu--open) .cardify__background{\
                mask-image:linear-gradient(to bottom,white 50%,rgba(255,255,255,0) 100%);\
            }\
            \
            /* СКРЫТЬ СТАРЫЙ ПЛАГИН */\
            .cardify .original_title{display:none !important}\
            \
            .head.nodisplay{transform:translateY(-100%)}\
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

        // Хранилище активных трейлеров
        var activeTrailers = {};

        // Слушатель
        Lampa.Listener.follow('full', function(e) {
            if (e.type == 'complite') {
                log('Full complite');
                
                var render = e.object.activity.render();
                var activityId = e.object.activity.id || Date.now();
                
                render.find('.full-start__background').addClass('cardify__background');

                // Оригинальные названия
                if (Lampa.Storage.field('cardify_show_original_title') !== false && e.data.movie) {
                    OriginalTitle.fetch(e.data.movie).then(function(titles) {
                        OriginalTitle.render(render.find('.cardify__left'), titles);
                    });
                }

                // Фоновый трейлер
                if (Lampa.Storage.field('cardify_run_trailers') !== false && e.data.movie) {
                    var isTv = !!(e.object.method && e.object.method === 'tv');
                    
                    iTunesTrailer.load(e.data.movie, isTv, function(video) {
                        if (video && video.url) {
                            log('Запускаем фоновый трейлер');
                            
                            // Удаляем старый если есть
                            if (activeTrailers[activityId]) {
                                activeTrailers[activityId].destroy();
                            }
                            
                            activeTrailers[activityId] = new BackgroundTrailer(render, video);
                        }
                    });
                }
            }
            
            // Уничтожаем трейлер при выходе
            if (e.type == 'destroy') {
                var activityId = e.object.activity.id || 0;
                if (activeTrailers[activityId]) {
                    activeTrailers[activityId].destroy();
                    delete activeTrailers[activityId];
                }
            }
        });

        log('Плагин инициализирован');
    }

    if (window.appready) startPlugin();
    else Lampa.Listener.follow('app', function(e) { if (e.type == 'ready') startPlugin(); });

})();
