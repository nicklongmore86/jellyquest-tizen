// Shared by every spec that asserts a user-facing message actually reached
// the screen. Extracted from requests.spec.mjs (PR #18), which still owns the
// self-test proving each of the three checks below can fail.
import assert from 'node:assert/strict';

// Visibility alone accepts text beneath the opaque app root. Check its real
// stacking context and the hit target at the message's center as well.
export async function assertPainted(locator) {
    const paint = await locator.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return {
            insideRoot: document.getElementById('jellyquest-root').contains(element),
            hasHitTarget: top !== null,
            unobscured: top === element || element.contains(top),
        };
    });
    assert.equal(paint.insideRoot, true, 'message is not inside #jellyquest-root');
    assert.equal(paint.hasHitTarget, true, 'message center is outside the viewport or has no hit target');
    assert.equal(paint.unobscured, true, 'message is obscured by another painted element');
}
