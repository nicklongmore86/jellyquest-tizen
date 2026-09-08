// Dedicated Series route seam. S4 replaces this placeholder with the actual
// season/episode browser; this module deliberately makes no show API request
// and exposes no playback action because a Series is not itself playable.
(function () {
    'use strict';

    // callbacks: { onBack() }
    function renderSeries(container, item, callbacks) {
        container.innerHTML = '';
        container.className = 'jq-detail-screen jq-series-screen';

        var heading = document.createElement('h1');
        heading.className = 'jq-detail-title jq-series-title';
        heading.textContent = item && item.Name ? item.Name : 'Series';
        container.appendChild(heading);

        // Keep Back immediately below the title. Besides making the only
        // action prominent, this places it alongside the persistent rail so
        // ArrowLeft has a visible rail candidate in the focus geometry.
        var back = document.createElement('button');
        back.className = 'jq-back-button jq-focusable';
        back.textContent = '< Back';
        back.setAttribute('data-jq-autofocus', '');
        back.addEventListener('click', callbacks.onBack);
        container.appendChild(back);

        var status = document.createElement('p');
        status.className = 'jq-detail-error jq-series-status';
        status.textContent = 'Series browsing is not available yet.';
        container.appendChild(status);

        window.JellyQuestFocus.focusFirst(container);
    }

    window.JellyQuestSeriesScreen = {
        render: renderSeries
    };
})();
