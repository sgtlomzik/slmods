(function () {
    'use strict';

    function cardify_full_start() {
        if (window.cardify_detail_plugin) return;
        window.cardify_detail_plugin = true;

        // CSS Стили для превращения обычного описания в Cardify
        var style = `
            /* Делаем контейнер относительным для позиционирования фона */
            .full-start {
                position: relative !important;
                background-color: #000 !important;
                overflow: hidden;
            }

            /* Скрываем стандартный фон, чтобы заменить своим */
            .full-start__background {
                display: none !important;
            }

            /* Создаем наш слой фона */
            .cardify-bg-layer {
                position: absolute;
                top: 0; left: 0; right: 0; bottom: 0;
                background-size: cover;
                background-position: center top;
                background-repeat: no-repeat;
                opacity: 0.6; /* Немного затемняем саму картинку */
                z-index: 0;
                transition: opacity 0.5s ease;
            }

            /* Градиент поверх картинки, чтобы текст читался */
            .cardify-bg-layer::after {
                content: '';
                position: absolute;
                top: 0; left: 0; right: 0; bottom: 0;
                background: linear-gradient(to top, #000 5%, rgba(0,0,0,0.8) 40%, rgba(0,0,0,0.2) 100%);
            }

            /* Скрываем постер слева */
            .full-start__poster {
                display: none !important;
            }

            /* Растягиваем блок с текстом на всю ширину */
            .full-start__body {
                position: relative;
                z-index: 2;
                width: 100% !important;
                padding-left: 2em !important; /* Отступ слева */
                padding-right: 2em !important;
                padding-bottom: 2em !important;
                display: flex;
                flex-direction: column;
                justify-content: flex-end; /* Прижимаем текст к низу */
                min-height: 80vh; /* Минимальная высота */
            }

            /* Увеличиваем заголовок */
            .full-start__title {
                font-size: 3.5em !important;
                line-height: 1.1;
                margin-bottom: 0.2em;
                text-shadow: 2px 2px 4px rgba(0,0,0,0.9);
            }

            /* Стиль описания */
            .full-start__description {
                font-size: 1.1em;
                line-height: 1.6;
                color: #ddd;
                max-width: 80%; /* Чтобы строки не были слишком длинными */
                text-shadow: 1px 1px 2px rgba(0,0,0,0.9);
            }
            
            /* Поднимаем кнопки чуть выше */
            .full-start__buttons {
                margin-top: 1.5em;
            }
        `;

        Lampa.Utils.addStyle(style);

        // Слушаем событие открытия карточки
        Lampa.Listener.follow('full', function (e) {
            // Событие 'complite' (опечатка в ядре лампы, так и пишем) означает, что HTML построен
            if (e.type == 'complite') {
                var html = e.object.activity.render();
                var data = e.data.movie || e.data;

                // Находим картинку: сначала пробуем backdrop (горизонтальная), если нет - poster
                var img = data.backdrop_path || data.poster_path || data.img;
                
                // Формируем полный URL для TMDB в высоком качестве (original)
                var img_url = img;
                if (img && img.indexOf('http') === -1) {
                    img_url = 'https://image.tmdb.org/t/p/original' + img;
                }

                // Удаляем старый слой Cardify если он вдруг остался
                html.find('.cardify-bg-layer').remove();

                // Добавляем наш фон
                if (img_url) {
                    html.prepend('<div class="cardify-bg-layer" style="background-image: url(' + img_url + ')"></div>');
                }
            }
        });
        
        console.log('Cardify Detail Plugin: Loaded');
    }

    if (window.appready) cardify_full_start();
    else Lampa.Listener.follow('app', 'ready', cardify_full_start);

})();
