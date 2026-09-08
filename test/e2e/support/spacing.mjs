import assert from 'node:assert/strict';

// Modern Chromium supports flex gap; disable it to measure the margins that
// actually provide spacing on the target TVs. Never accept an empty fixture.
export async function assertSiblingSpacing(page, selector, axis, expectedContainers = 1) {
    await page.addStyleTag({ content: `${selector} { gap: 0 !important; }` });
    const gaps = await page.locator(selector).evaluateAll((containers) =>
        containers.map((container) => getComputedStyle(container).gap));
    for (const gap of gaps) {
        assert.equal(gap, '0px', `${selector}: gap suppression must take effect`);
    }
    const groups = await page.locator(selector).evaluateAll((containers) => containers.map((container) =>
        Array.from(container.children).map((child) => {
            const { left, right, top, bottom, width, height } = child.getBoundingClientRect();
            return { left, right, top, bottom, width, height };
        })
    ));
    assert.ok(groups.length > 0, `${selector}: expected a rendered container`);
    assert.equal(groups.length, expectedContainers, `${selector}: expected fixture container count`);
    for (const [group, rects] of groups.entries()) {
        for (const rect of rects) {
            assert.ok(rect.width > 0 && rect.height > 0, `${selector}: children must have visible geometry`);
        }
        // PER CONTAINER, not across all of them collectively. The aggregate
        // form let a container with a single child ride on its siblings'
        // pairs: zero sibling margin could be injected into that one row and
        // this helper would still pass, while on both household sets zero
        // spacing is exactly what makes the D-pad skip cards.
        let pairs = 0;
        for (let i = 1; i < rects.length; i++) {
            const separation = axis === 'x'
                ? rects[i].left - rects[i - 1].right
                : rects[i].top - rects[i - 1].bottom;
            assert.ok(separation > 0,
                `${selector} group ${group}, children ${i - 1}/${i}: ${axis} separation ${separation}px must be positive`);
            pairs++;
        }
        assert.ok(pairs > 0,
            `${selector} group ${group}: a container with fewer than two children measures no spacing at all`);
    }
}

export async function assertWrappedSpacing(page, selector) {
    await page.addStyleTag({ content: `${selector} { gap: 0 !important; }` });
    assert.equal(await page.locator(selector).evaluate((container) => getComputedStyle(container).gap),
        '0px', `${selector}: gap suppression must take effect`);
    const { rects, input } = await page.locator(selector).evaluate((container) => {
        const rect = (element) => {
            const { left, right, top, bottom } = element.getBoundingClientRect();
            return { left, right, top, bottom };
        };
        return {
            rects: Array.from(container.children).map(rect),
            input: rect(document.querySelector('.jq-requests-input')),
        };
    });
    assert.equal(rects.length, 3, 'Requests fixture must render all three matches');
    const rows = [];
    for (const rect of rects) {
        assert.ok(rect.right > rect.left && rect.bottom > rect.top, 'Request cards must have visible geometry');
        const row = rows.find((row) => Math.abs(row[0].top - rect.top) < 1);
        if (row) row.push(rect);
        else rows.push([rect]);
    }
    assert.equal(rows.length, 2, 'Fixture must wrap into two lines');
    assert.equal(rows[0].length, 2, 'First line must exercise horizontal spacing');
    assert.equal(rows[1].length, 1, 'Second line must exercise vertical spacing');
    const horizontal = rows[0][1].left - rows[0][0].right;
    const vertical = rows[1][0].top - Math.max(...rows[0].map((rect) => rect.bottom));
    assert.ok(horizontal > 0, `${selector}: x separation ${horizontal}px must be positive`);
    assert.ok(vertical > 0, `${selector}: y separation ${vertical}px must be positive`);
    // The negative container margin must cancel the first child's margins,
    // including on the wrapped line, preserving the old gap layout's origin.
    for (const row of rows) {
        assert.ok(Math.abs(row[0].left - input.left) < 1, `${selector}: line must align with input`);
    }
    assert.ok(Math.abs(rects[0].top - input.bottom - 32) < 1,
        `${selector}: first line must start 32px below input`);
}
