// Things that should never appear in a product screenshot. Hidden with display:none
// (so they also stop animating) unless determinism.hideBuiltins is false.
export const BUILTIN_HIDE = [
  // Cookie / consent banners
  '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#CybotCookiebotDialog', '#cookiebanner', '#cookie-banner',
  '#cookie-consent', '#cookie-notice', '#cookieConsent', '.cc-window', '.cc-banner', '.cookie-banner', '.cookie-consent',
  '.cookie-notice', '#usercentrics-root', '#didomi-host', '.qc-cmp2-container', '#truste-consent-track', '.osano-cm-window',
  '#termly-code-snippet-support', '[aria-label="cookieconsent" i]', '[aria-label*="cookie consent" i]', '[id^="sp_message_container"]',
  // Chat / support widgets
  '#intercom-container', '.intercom-lightweight-app', '.intercom-launcher', '#hubspot-messages-iframe-container',
  '#crisp-chatbox', '.crisp-client', '#drift-widget', '#drift-frame-controller', '#fc_frame', '#launcher', '#zsiq_float',
  '.zsiq_floatmain', '#tidio-chat', '#chat-widget-container', '.chat-widget', 'iframe[title*="chat" i]', '#beacon-container',
  '.olark-launch-button', '#tawk-bubble-container', '.woot-widget-holder', '.woot--bubble-holder',
  // Toasts & transient notifications
  '[data-sonner-toaster]', '.Toastify', '.toast', '.toaster', '.notistack-SnackbarContainer', '#toast-container', '.chakra-toast',
  // Dev overlays and preview toolbars
  'nextjs-portal', '#__next-build-watcher', '[data-nextjs-toast]', 'vercel-live-feedback', '#vercel-live-feedback',
  '[data-vercel-toolbar]', '#__vite-plugin-checker', 'astro-dev-toolbar', '#webpack-dev-server-client-overlay',
];

// Things that mean "this page is still loading". Must be absent (or invisible) before capture.
export const BUILTIN_BUSY = [
  '[aria-busy="true"]',
  '[role="progressbar"]:not([aria-valuenow])',
  '[class*="skeleton" i]',
  '[class*="shimmer" i]',
  '[class*="spinner" i]',
  '[class*="loading" i]:not(html):not(body)',
  '[class*="loader" i]:not(html):not(body)',
  '[data-loading="true"]',
  '.MuiSkeleton-root',
  '.ant-skeleton',
  '.chakra-skeleton',
];
