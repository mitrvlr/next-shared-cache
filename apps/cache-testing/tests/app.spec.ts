import { scheduler } from 'node:timers/promises';
import { expect, test } from '@playwright/test';

const paths = [
    '/app/with-params/dynamic-true/200',
    // '/app/with-params/dynamic-false/200', // this fails with native next.js cache
    '/app/no-params/dynamic-true/200',
    '/app/no-params/dynamic-false/200',
];

test.describe('On-demand revalidation', () => {
    for (const path of paths) {
        test(`If revalidate by path or by tag is clicked, then page should be fresh after reload ${path}`, async ({
            page,
            baseURL,
        }) => {
            const url = new URL(path, `${baseURL}:3000`);

            await page.goto(url.href);

            await page.getByTestId('revalidate-button-path').click();

            await expect(page.getByTestId('is-revalidated-by-path')).toContainText('Revalidated at');

            await page.reload();

            let pageValue = (await page.getByTestId('data').innerText()).valueOf();

            await page.reload();

            await expect(page.getByTestId('data')).toHaveText(pageValue);

            await page.getByTestId('revalidate-button-path').click();

            await expect(page.getByTestId('is-revalidated-by-path')).toContainText('Revalidated at');

            await page.reload();

            await expect(page.getByTestId('data')).not.toHaveText(pageValue);

            pageValue = (await page.getByTestId('data').innerText()).valueOf();

            await page.reload();

            await expect(page.getByTestId('data')).toHaveText(pageValue);

            await page.getByTestId('revalidate-button-tag').click();

            await expect(page.getByTestId('is-revalidated-by-tag')).toContainText('Revalidated at');

            await page.reload();

            await expect(page.getByTestId('data')).not.toHaveText(pageValue);

            pageValue = (await page.getByTestId('data').innerText()).valueOf();

            await page.reload();

            await expect(page.getByTestId('data')).toHaveText(pageValue);
        });
    }

    for (const path of paths) {
        test(`If revalidate by path is clicked on page A, then page B should be fresh on load ${path}`, async ({
            context,
            baseURL,
        }) => {
            const appAUrl = new URL(path, `${baseURL}:3000`);

            const appA = await context.newPage();

            await appA.goto(appAUrl.href);

            await appA.getByTestId('revalidate-button-path').click();

            await expect(appA.getByTestId('is-revalidated-by-path')).toContainText('Revalidated at');

            const appBUrl = new URL(path, `${baseURL}:3001`);

            const appB = await context.newPage();

            await appB.goto(appBUrl.href);

            const valueFromPageA = Number.parseInt((await appA.getByTestId('data').innerText()).valueOf(), 10);

            const valueFromPageB = Number.parseInt((await appB.getByTestId('data').innerText()).valueOf(), 10);

            expect(valueFromPageA + 1 === valueFromPageB).toBe(true);
        });
    }

    for (const path of paths) {
        test(`If revalidate by tag is clicked on page A, then page B should be fresh on load ${path}`, async ({
            context,
            baseURL,
        }) => {
            const appAUrl = new URL(path, `${baseURL}:3000`);

            const appA = await context.newPage();

            await appA.goto(appAUrl.href);

            await appA.getByTestId('revalidate-button-tag').click();

            await expect(appA.getByTestId('is-revalidated-by-tag')).toContainText('Revalidated at');

            const appBUrl = new URL(path, `${baseURL}:3001`);

            const appB = await context.newPage();

            await appB.goto(appBUrl.href);

            const valueFromPageA = Number.parseInt((await appA.getByTestId('data').innerText()).valueOf(), 10);

            const valueFromPageB = Number.parseInt((await appB.getByTestId('data').innerText()).valueOf(), 10);

            expect(valueFromPageA + 1 === valueFromPageB).toBe(true);
        });
    }
});

test.describe('Time-based revalidation', () => {
    for (const path of paths) {
        test(`Page should be fresh after becoming stale and reloaded twice ${path}`, async ({ page, baseURL }) => {
            const url = new URL(path, `${baseURL}:3000`);

            await page.goto(url.href);

            await page.getByTestId('revalidate-button-path').click();

            await expect(page.getByTestId('is-revalidated-by-path')).toContainText('Revalidated at');

            await page.reload();

            const pageValue = (await page.getByTestId('data').innerText()).valueOf();

            await page.reload();

            await expect(page.getByTestId('data')).toHaveText(pageValue);

            await expect(page.getByTestId('cache-state')).toContainText('stale', { timeout: 7500 });

            // Temporary workaround: Addressing intermittent test failures observed in GitHub Actions.
            await scheduler.wait(1000);

            await page.reload();

            await expect(page.getByTestId('data')).toHaveText(pageValue);

            await page.reload();

            await expect(page.getByTestId('data')).not.toHaveText(pageValue);
        });
    }

    for (const path of paths) {
        test(`If page A is stale, then page B should be fresh after load and reload ${path}`, async ({
            context,
            baseURL,
        }) => {
            const appA = await context.newPage();

            const appAUrl = new URL(path, `${baseURL}:3000`);

            await appA.goto(appAUrl.href);

            await appA.getByTestId('revalidate-button-path').click();

            await expect(appA.getByTestId('is-revalidated-by-path')).toContainText('Revalidated at');

            await appA.reload();

            await expect(appA.getByTestId('cache-state')).toContainText('stale', { timeout: 7500 });

            const appB = await context.newPage();

            const appBUrl = new URL(path, `${baseURL}:3001`);

            await appB.goto(appBUrl.href);

            await expect(appB.getByTestId('cache-state')).toContainText('stale', { timeout: 7500 });

            await appB.reload();

            const valueFromPageA = Number.parseInt((await appA.getByTestId('data').innerText()).valueOf(), 10);

            const valueFromPageB = Number.parseInt((await appB.getByTestId('data').innerText()).valueOf(), 10);

            if (valueFromPageB - valueFromPageA > 1) {
                console.warn('Page B is more than one revalidation ahead of page A.');
            }

            expect(valueFromPageA < valueFromPageB).toBe(true);
        });
    }

    for (const path of paths) {
        test(`If page A is stale and reloaded, then page B should be fresh after load ${path}`, async ({
            context,
            baseURL,
        }) => {
            const appAUrl = new URL(path, `${baseURL}:3000`);

            const appA = await context.newPage();

            await appA.goto(appAUrl.href);

            await appA.getByTestId('revalidate-button-path').click();

            await expect(appA.getByTestId('is-revalidated-by-path')).toContainText('Revalidated at');

            await appA.reload();

            await expect(appA.getByTestId('cache-state')).toContainText('stale', { timeout: 7500 });

            await appA.reload();

            await appA.reload();

            const appB = await context.newPage();

            const appBUrl = new URL(path, `${baseURL}:3001`);

            await appB.goto(appBUrl.href);

            const valueFromPageA = Number.parseInt((await appA.getByTestId('data').innerText()).valueOf(), 10);

            const valueFromPageB = Number.parseInt((await appA.getByTestId('data').innerText()).valueOf(), 10);

            expect(valueFromPageA === valueFromPageB).toBe(true);
        });
    }
});

test.describe('Data consistency between two app instances for the same page', () => {
    for (const path of paths) {
        test(`Should be maintained when loaded at the same time ${path}`, async ({ context, baseURL }) => {
            const appAUrl = new URL(path, `${baseURL}:3000`);
            const appBUrl = new URL(path, `${baseURL}:3001`);

            const appA = await context.newPage();
            const appB = await context.newPage();

            await appA.goto(appAUrl.href);
            await appB.goto(appBUrl.href);

            await appA.getByTestId('revalidate-button-path').click();

            await expect(appA.getByTestId('is-revalidated-by-path')).toContainText('Revalidated at');

            await appA.reload();
            await appB.reload();

            const valueFromPageA = Number.parseInt((await appA.getByTestId('data').innerText()).valueOf(), 10);

            const valueFromPageB = Number.parseInt((await appB.getByTestId('data').innerText()).valueOf(), 10);

            expect(valueFromPageA === valueFromPageB).toBe(true);
        });
    }
});

test.describe('Data consistency after server restart', () => {
    for (const path of paths) {
        test(`Should be maintained between App A and App B after App B server restarts ${path}`, async ({
            context,
            baseURL,
        }) => {
            const appAUrl = new URL(path, `${baseURL}:3000`);
            const appBUrl = new URL(path, `${baseURL}:3001`);

            const appA = await context.newPage();
            const appB = await context.newPage();

            await appA.goto(appAUrl.href);
            await appB.goto(appBUrl.href);

            await appA.getByTestId('revalidate-button-path').click();

            await expect(appA.getByTestId('is-revalidated-by-path')).toContainText('Revalidated at');

            await appA.reload();
            await appB.reload();

            let valueFromPageA = Number.parseInt((await appA.getByTestId('data').innerText()).valueOf(), 10);

            const valueFromPageB = Number.parseInt((await appB.getByTestId('data').innerText()).valueOf(), 10);

            expect(valueFromPageA === valueFromPageB).toBe(true);

            const restartResult = await fetch(`${baseURL}:9000/restart/${appBUrl.port}`);

            expect(restartResult.status).toBe(200);

            for await (const _ of [1, 2, 3]) {
                await appA.getByTestId('revalidate-button-path').click();

                await expect(appA.getByTestId('is-revalidated-by-path')).toContainText('Revalidated at');

                await appA.reload();
            }

            valueFromPageA = Number.parseInt((await appA.getByTestId('data').innerText()).valueOf(), 10);

            await appB.reload();

            const valueFromPageBAfterRestart = Number.parseInt(
                (await appB.getByTestId('data').innerText()).valueOf(),
                10,
            );

            expect(valueFromPageBAfterRestart === valueFromPageA).toBe(true);
        });
    }
});

test.describe('SSR', () => {
    test('verify initial cache state is fresh on SSR page load', async ({ page, baseURL }) => {
        const url = new URL('/app/no-params/ssr/200', `${baseURL}:3000`);

        await page.goto(url.href);

        await expect(page.getByTestId('cache-state')).toContainText('fresh');
    });

    test('ensure data value increments by 1 on SSR page reload', async ({ page, baseURL }) => {
        const url = new URL('/app/no-params/ssr/200', `${baseURL}:3000`);

        await page.goto(url.href);

        const valueFromPage = Number.parseInt((await page.getByTestId('data').innerText()).valueOf(), 10);

        await page.reload();

        const valueFromPageAfterReload = Number.parseInt((await page.getByTestId('data').innerText()).valueOf(), 10);

        expect(valueFromPageAfterReload - valueFromPage === 1).toBe(true);
    });
});
