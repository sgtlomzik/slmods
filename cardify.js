(function () {
    'use strict';

    function cardify_start() {
        // Проверяем, не запущен ли плагин дважды
        if (window.cardify_plugin_loaded) return;
        window.cardify_plugin_loaded = true;

        // Добавляем CSS стили (градиент, позиционирование текста)
        var css = `
            /* Скрываем стандартный блок с информацией под постером */
            .cardify-enabled .card__textbox {
                display: none !important;
            }
            
            /* Настраиваем контейнер постера */
            .cardify-enabled .card__view {
                position: relative;
                overflow: hidden;
                border-radius: 10px; /* Скругление углов */
            }

            /* Создаем новый блок для инфо поверх постера */
            .cardify-info-overlay {
                position: absolute;
                bottom: 0;
                left: 0;
                width: 100%;
                padding: 10px;
                background: linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.6) 60%, rgba(0,0,0,0) 100%);
                display: flex;
                flex-direction: column;
                justify-content: flex-end;
                z-index: 2;
                pointer-events: none; /* Чтобы клик проходил сквозь текст */
                box-sizing: border-box;
                min-height: 50%;
            }

            .cardify-title {
                font-size: 1.1em;
                font-weight: bold;
                color: #fff;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
                margin-bottom: 3px;
            }

            .cardify-details {
                font-size: 0.8em;
                color: #ccc;
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .cardify-quality {
                background: #d32f2f;
                color: white;
                padding: 1px 4px;
                border-radius: 3px;
                font-size: 0.7em;
                font-weight: bold;
            }

            .cardify-year {
                color: #bbb;
            }

            /* Анимация фокуса (выделения) */
            .cardify-enabled.focus .card__view {
                box-shadow: 0 0 0 3px #fff; 
            }
        `;

        Lampa.Utils.addStyle(css);

        // Сохраняем оригинальный метод отрисовки
        var original_view = Lampa.Card.prototype.view;

        // Переопределяем метод view
        Lampa.Card.prototype.view = function () {
            // Вызываем оригинальный метод, чтобы получить стандартную карточку
            // Это гарантирует, что вся логика ядра (клики, меню) сохранится
            var card_element = original_view.call(this);
            var _this = this; // Ссылка на объект карточки

            // Добавляем класс-маркер
            $(card_element).addClass('cardify-enabled');

            // Находим блок с картинкой (.card__view)
            var view_container = $(card_element).find('.card__view');
            
            // Если карточка нестандартная (например, настройки), пропускаем
            if (!view_container.length || !this.data) return card_element;

            // Формируем HTML для оверлея
            var title = this.data.title || this.data.name || '';
            var release_year = (this.data.release_date || this.data.first_air_date || '----').substring(0, 4);
            
            // Качество (если есть в данных, иначе скрываем)
            var quality_mark = '';
            /* Логика определения качества может отличаться, 
               но обычно берется из this.data.quality если плагины парсеров работают */
            
            var info_html = `
                <div class="cardify-info-overlay">
                    <div class="cardify-title">${title}</div>
                    <div class="cardify-details">
                        <span class="cardify-year">${release_year}</span>
                        ${this.data.vote_average ? '<span style="color:#fbc02d">★ ' + parseFloat(this.data.vote_average).toFixed(1) + '</span>' : ''}
                    </div>
                </div>
            `;

            // Вставляем наш блок поверх картинки
            view_container.append(info_html);

            // Опционально: Если нужно скрыть оригинальный блок с текстом сразу при рендере
            // $(card_element).find('.card__textbox').remove(); 
            // Но лучше оставить CSS (display: none), чтобы логика лампы могла читать оттуда текст если нужно.

            return card_element;
        };
        
        console.log('Cardify Universal Plugin: Loaded');
    }

    if (window.appready) cardify_start();
    else Lampa.Listener.follow('app', 'ready', cardify_start);

})();
