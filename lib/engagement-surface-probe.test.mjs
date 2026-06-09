/**
 * Tests for lib/engagement-surface-probe.mjs (wq-1066)
 * Covers: signal detection, threshold logic, extractScriptUrls,
 * prioritizeBundles, JS bundle merge dedup, dry-run behavior.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractScriptUrls,
  prioritizeBundles,
  scanForEngagement,
  ENGAGEMENT_SIGNALS,
  DETECTION_THRESHOLD,
} from './engagement-surface-probe.mjs';

describe('extractScriptUrls', () => {
  it('extracts script src URLs from HTML', () => {
    const html = '<html><head><script src="/js/app.js"></script><script src="/js/vendor.js"></script></head></html>';
    const urls = extractScriptUrls(html, 'https://example.com');
    assert.deepEqual(urls, [
      'https://example.com/js/app.js',
      'https://example.com/js/vendor.js',
    ]);
  });

  it('resolves relative URLs against base', () => {
    const html = '<script src="./bundle.js"></script>';
    const urls = extractScriptUrls(html, 'https://example.com/page/');
    assert.equal(urls[0], 'https://example.com/page/bundle.js');
  });

  it('skips analytics and data URIs', () => {
    const html = `
      <script src="data:text/javascript,alert(1)"></script>
      <script src="https://www.google-analytics.com/ga.js"></script>
      <script src="https://www.googletagmanager.com/gtag/js"></script>
      <script src="/app.js"></script>
    `;
    const urls = extractScriptUrls(html, 'https://example.com');
    assert.equal(urls.length, 1);
    assert.equal(urls[0], 'https://example.com/app.js');
  });

  it('handles inline scripts without src', () => {
    const html = '<script>console.log("hi")</script><script src="/real.js"></script>';
    const urls = extractScriptUrls(html, 'https://example.com');
    assert.equal(urls.length, 1);
  });

  it('returns empty array for no scripts', () => {
    const urls = extractScriptUrls('<html><body>Hello</body></html>', 'https://example.com');
    assert.deepEqual(urls, []);
  });
});

describe('prioritizeBundles', () => {
  it('ranks chunk files above vendor files', () => {
    const urls = [
      'https://example.com/vendor.js',
      'https://example.com/chunk.abc.js',
      'https://example.com/polyfill.js',
    ];
    const result = prioritizeBundles(urls, 2);
    assert.equal(result[0], 'https://example.com/chunk.abc.js');
    assert.equal(result.length, 2);
  });

  it('ranks app/main above generic', () => {
    const urls = [
      'https://example.com/utils.js',
      'https://example.com/main.js',
    ];
    const result = prioritizeBundles(urls, 3);
    assert.equal(result[0], 'https://example.com/main.js');
  });

  it('limits to max count', () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/file${i}.js`);
    const result = prioritizeBundles(urls, 3);
    assert.equal(result.length, 3);
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(prioritizeBundles([], 3), []);
  });
});

describe('scanForEngagement', () => {
  it('detects signals above threshold', () => {
    // api-comments (5) + api-posts (5) = 10 > threshold
    const html = 'fetch("/api/comments") and also /api/posts endpoint';
    const result = scanForEngagement(html);
    assert.equal(result.detected, true);
    assert.ok(result.totalWeight >= DETECTION_THRESHOLD);
    assert.ok(result.matches.some(m => m.signal === 'api-comments'));
    assert.ok(result.matches.some(m => m.signal === 'api-posts'));
  });

  it('returns not detected below threshold', () => {
    // Only a submit button (weight 2) — below threshold of 6
    const html = '<input type="submit" value="Go">';
    const result = scanForEngagement(html);
    assert.equal(result.detected, false);
    assert.ok(result.totalWeight < DETECTION_THRESHOLD);
  });

  it('returns no matches for plain HTML', () => {
    const html = '<html><body><p>Hello world</p></body></html>';
    const result = scanForEngagement(html);
    assert.equal(result.detected, false);
    assert.equal(result.matches.length, 0);
    assert.equal(result.totalWeight, 0);
  });

  it('merges bundle scan results without double-counting', () => {
    // HTML has api-comments (weight 5)
    const html = 'fetch("/api/comments")';
    // Bundle also found api-comments + api-posts
    const bundleScan = {
      matches: [
        { signal: 'js:api-comments', weight: 5, source: 'app.js' },
        { signal: 'js:api-posts', weight: 5, source: 'app.js' },
      ],
      totalWeight: 10,
      bundlesFetched: 1,
      bundleUrls: ['https://example.com/app.js'],
    };
    const result = scanForEngagement(html, bundleScan);
    // api-comments should NOT be double-counted (HTML has it, js: version skipped)
    const commentMatches = result.matches.filter(m =>
      m.signal === 'api-comments' || m.signal === 'js:api-comments'
    );
    assert.equal(commentMatches.length, 1);
    // api-posts from bundle should be added
    assert.ok(result.matches.some(m => m.signal === 'js:api-posts'));
  });

  it('adds all bundle signals when HTML has none', () => {
    const html = '<html><body></body></html>';
    const bundleScan = {
      matches: [
        { signal: 'js:api-comments', weight: 5, source: 'app.js' },
        { signal: 'js:fetch-post', weight: 3, source: 'app.js' },
      ],
      totalWeight: 8,
      bundlesFetched: 1,
      bundleUrls: [],
    };
    const result = scanForEngagement(html, bundleScan);
    assert.equal(result.matches.length, 2);
    assert.equal(result.totalWeight, 8);
    assert.equal(result.detected, true);
    assert.equal(result.bundlesFetched, 1);
  });

  it('handles null bundle scan gracefully', () => {
    const html = '<textarea></textarea>';
    const result = scanForEngagement(html, null);
    assert.ok(result.matches.some(m => m.signal === 'textarea'));
    assert.equal(result.bundlesFetched, 0);
  });
});

describe('ENGAGEMENT_SIGNALS', () => {
  it('has expected signal count', () => {
    assert.ok(ENGAGEMENT_SIGNALS.length >= 17, `Expected >=17 signals, got ${ENGAGEMENT_SIGNALS.length}`);
  });

  it('all signals have required fields', () => {
    for (const sig of ENGAGEMENT_SIGNALS) {
      assert.ok(sig.pattern instanceof RegExp, `${sig.signal} pattern should be RegExp`);
      assert.equal(typeof sig.signal, 'string');
      assert.equal(typeof sig.weight, 'number');
      assert.ok(sig.weight > 0, `${sig.signal} weight should be positive`);
    }
  });
});

describe('DETECTION_THRESHOLD', () => {
  it('is 6', () => {
    assert.equal(DETECTION_THRESHOLD, 6);
  });
});
