/**
 * WiFiLeads Widget v5.0.0 — collecte de leads (double opt-in) pour portails captifs WiFi.
 */
(function bootstrap(window, document) {
    'use strict';

    // CONFIG
    const _script  = document.currentScript;
    const _origin  = _script ? new URL(_script.src).origin : '';
    const CONFIG = Object.freeze({
        API_BASE:           `https://backlead-web.onrender.com/api/v1/core_data/portal/`,
        STORAGE_PREFIX:     'cdw_',
        OVERLAY_Z_INDEX:    99_999,
        ANIMATION_MS:       400,
        RESEND_COOLDOWN_MS: 60_000,
        TOAST_DURATION_MS:  4_000,
        GEO_TIMEOUT_MS:     2_000,
        API_TIMEOUT_MS:     30_000,
        MAX_WAIT_MS:        10_000,
        OTP_LENGTH:         6,
        ITI: {
            CSS: `https://cdn.jsdelivr.net/npm/intl-tel-input@24.8.2/build/css/intlTelInput.css`,
            JS:  `https://cdn.jsdelivr.net/npm/intl-tel-input@24.8.2/build/js/intlTelInputWithUtils.min.js`,
        },
        COUNTRY_ORDER: [
            'bj','ci','sn','tg','ml','bf','ne','fr','be','ch','ca','us','gb',
            'dz','ao','bw','cd','cg','cm','cv','dj','eg','er','et','ga','gh',
            'gm','gn','gq','gw','ke','km','lr','ls','ly','ma','mg','mr','mu',
            'mw','mz','na','ng','rw','sc','sd','sl','so','ss','st','sz','td',
            'tn','tz','ug','za','zm','zw',
        ],
        MAC_URL_PARAMS: [
            'mac','mac_address','client_mac','id',
        ],
    });

    // LOGGER
    const Log = {
        info:  (...a) => console.log('[CDW]',  ...a),
        warn:  (...a) => console.warn('[CDW]', ...a),
        error: (...a) => console.error('[CDW]',...a),
    };

    const STRINGS = {
        fr: {
            verifying: 'Vérification en cours\u2026',
            reconfirmMessage: 'Veuillez reconfirmer vos informations svp.',
        },
        en: {
            verifying: 'Verifying\u2026',
            reconfirmMessage: 'Please reconfirm your details to keep using the WiFi.',
        },
    };
    const I18n = {
        lang: 'fr',
        setLang(lang) { this.lang = STRINGS[lang] ? lang : 'fr'; },
        t(key) { return STRINGS[this.lang][key] ?? STRINGS.fr[key] ?? key; },
    };

    // STORAGE
    const Storage = {
        _key: (k) => `${CONFIG.STORAGE_PREFIX}${k}`,
        set(key, value) {
            try { localStorage.setItem(this._key(key), value); }
            catch { Log.warn('localStorage indisponible.'); }
        },
        get(key) {
            try { return localStorage.getItem(this._key(key)); }
            catch { return null; }
        },
    };

    // API CLIENT
    class ApiError extends Error {
        constructor(message, status, data) {
            super(message);
            this.name   = 'ApiError';
            this.status = status;
            this.data   = data;
        }
    }
    const Api = {
        async request(url, options = {}) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);
            let response;
            try {
                response = await fetch(url, { ...options, credentials: 'include', signal: controller.signal });
            } catch (err) {
                if (err.name === 'AbortError') {
                    throw new ApiError('Le serveur met trop de temps à répondre.', 0, null);
                }
                throw new ApiError('Impossible de contacter le serveur.', 0, null);
            } finally {
                clearTimeout(timer);
            }
            const data = await response.json();
            if (!response.ok) {
                const message = (
                    data.detail ??
                    data.error  ??
                    data.message ??
                    (typeof data.payload === 'string' ? data.payload : null) ??
                    'Une erreur est survenue'
                );
                throw new ApiError(message, response.status, data);
            }
            return data;
        },
        post(endpoint, body) {
            return this.request(CONFIG.API_BASE + endpoint, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body),
            });
        },
        get(endpoint) {
            return this.request(CONFIG.API_BASE + endpoint, { method: 'GET' });
        },
    };

    // PORTAL API
    const PortalApi = {
        identify(publicKey, macAddress, clientToken = null) {
            const body = { public_key: publicKey, mac_address: macAddress };
            if (clientToken) body.client_token = clientToken;
            return Api.post('provision/', body);
        },
        submit(publicKey, macAddress, payload, clientToken, { identityConfirmed = false, verificationCode = null } = {}) {
            return Api.post('submit/', {
                public_key:   publicKey,
                mac_address:  macAddress,
                payload,
                client_token: clientToken,
                ...(identityConfirmed && { identity_confirmed: true }),
                ...(verificationCode && { verification_code: verificationCode }),
            });
        },
        confirm(clientToken, code) {
            return Api.post('confirm/', { client_token: clientToken, code });
        },
        resend(clientToken) {
            return Api.post('resend/', { client_token: clientToken });
        },
    };

    // DEVICE DETECTION
    const MAC_REGEX = /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/;
    const Device = {
        _normalize: (mac) => mac.toUpperCase().replace(/-/g, ':'),
        _isValid:   (mac) => MAC_REGEX.test(mac),
        _scriptTag() {
            return document.currentScript
                ?? document.querySelector('script[data-public-key]')
                ?? null;
        },
        _urlParam(name) {
            const match = new RegExp(`[?&]${name}=([^&]*)`, 'i').exec(window.location.search);
            return match ? decodeURIComponent(match[1]) : null;
        },
        resolvePublicKey(options = {}) {
            const tag = this._scriptTag();
            return options.public_key ?? tag?.getAttribute('data-public-key') ?? this._urlParam('public_key') ?? null;
        },
        resolveMAC() {
            const tag     = this._scriptTag(); // 1. Attribut data-mac (MikroTik, OpenNDS via template serveur)
            const rawAttr = tag?.getAttribute('data-mac');
            if (rawAttr && rawAttr !== '$(mac)') {
                const normalized = this._normalize(rawAttr);
                if (this._isValid(normalized)) { Log.info('MAC depuis data-mac :', normalized); return normalized; }
            }
            for (const param of CONFIG.MAC_URL_PARAMS) { // 2. Paramètres URL (UniFi, Coova-Chilli, Meraki, Aruba…)
                const val = this._urlParam(param);
                if (!val) continue;
                const normalized = this._normalize(val);
                if (this._isValid(normalized)) { Log.info(`MAC depuis ?${param}= :`, normalized); return normalized; }
            }
            Log.warn('Adresse MAC introuvable. MikroTik/OpenNDS: data-mac="$(mac)" sur <script>. UniFi/Coova-Chilli/Meraki: vérifiez le paramètre MAC dans la redirection.');
            return null;
        },
    };

    // ASSET LOADER
    const Loader = {
        style(url) {
            if (document.querySelector(`link[href="${url}"]`)) return;
            const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: url });
            document.head.appendChild(link);
        },
        script(url) {
            if (document.querySelector(`script[src="${url}"]`)) return Promise.resolve();
            return new Promise((resolve, reject) => {
                const s   = Object.assign(document.createElement('script'), { src: url });
                s.onload  = resolve;
                s.onerror = () => reject(new Error(`Impossible de charger : ${url}`));
                document.head.appendChild(s);
            });
        },
    };

    // DOM HELPERS
    const Dom = {
        revealPage() {
            document.body.style.visibility = '';
        },
        lockScroll() {
            document.documentElement.style.overflow = 'hidden';
            document.body.style.overflow = 'hidden';
        },
        unlockScroll() {
            document.documentElement.style.overflow = '';
            document.body.style.overflow = '';
        },
        // Crée un élément HTML avec props et enfants en une seule passe.
        el(tag, props = {}, ...children) {
            const element = Object.assign(document.createElement(tag), props);
            for (const child of children) {
                if (child == null) continue;
                element.append(typeof child === 'string' ? document.createTextNode(child) : child);
            }
            return element;
        },
        // Remplace tous les enfants d'un conteneur.
        replace(container, ...children) {
            container.replaceChildren(...children.filter(Boolean));
        },
    };

    // STYLES
    const Styles = {
        // Ajoute <meta viewport> si absente (pages de portail captif générées par le routeur ) 
        ensureViewportMeta() {
            if (document.querySelector('meta[name="viewport"]')) return;
            document.head.appendChild(Dom.el('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }));
        },
        inject() {
            this.ensureViewportMeta();
            if (document.getElementById('cdw-styles')) return;
            const Z = CONFIG.OVERLAY_Z_INDEX, D = CONFIG.ANIMATION_MS;
            const css = `
:root{--cdw-primary:#0F766E;--cdw-primary-dark:#0c615a;--cdw-primary-light:#579f9a;--cdw-primary-a14:rgba(15,118,110,.14);--cdw-primary-a25:rgba(15,118,110,.25);--cdw-primary-a30:rgba(15,118,110,.3);--cdw-primary-a45:rgba(15,118,110,.45);--cdw-primary-a55:rgba(15,118,110,.55);--cdw-primary-tint8:#ecf4f3;--cdw-primary-tint25:#c3dddb;--cdw-accent:#F59E0B;--cdw-ink:#111827;--cdw-muted:#6b7280;--cdw-card:#ffffff;--cdw-border:#e5e7eb;--cdw-field-bg:#f9fafb;--cdw-error:#dc2626;--cdw-error-bg:#fef2f2;--cdw-error-border:#fecaca;--cdw-success:#16a34a;--cdw-radius-lg:22px;--cdw-radius-md:14px;--cdw-font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}#cdw-overlay,#cdw-overlay *,#cdw-overlay *::before,#cdw-overlay *::after{box-sizing:border-box}#cdw-overlay{position:fixed;inset:0;background:radial-gradient(circle at 15% 0%,var(--cdw-primary-a14),transparent 55%),radial-gradient(circle at 100% 100%,rgba(245,158,11,.1),transparent 55%),rgba(15,23,42,.72);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;z-index:${Z};padding:20px;opacity:0;animation:cdw-fadeIn ${D}ms cubic-bezier(.4,0,.2,1) forwards}@keyframes cdw-fadeIn{to{opacity:1}}@keyframes cdw-fadeOut{to{opacity:0}}@keyframes cdw-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}@keyframes cdw-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.35);opacity:.35}}@keyframes cdw-fade{from{opacity:0}to{opacity:1}}@keyframes cdw-pop{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:scale(1)}}@keyframes cdw-slideInRight{from{opacity:0;transform:translateX(100px)}to{opacity:1;transform:translateX(0)}}@keyframes cdw-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){#cdw-overlay,#cdw-overlay *,#cdw-overlay *::before,#cdw-overlay *::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}}.cdw-modal{background:var(--cdw-card);border-radius:var(--cdw-radius-lg);max-width:440px;width:100%;max-height:85vh;overflow:hidden;box-shadow:0 20px 45px -18px rgba(15,23,42,.35),0 0 0 1px rgba(15,23,42,.04);font-family:var(--cdw-font);color:var(--cdw-ink);animation:cdw-rise ${D}ms cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column}@supports (max-height:85dvh){.cdw-modal{max-height:85dvh}}.cdw-modal-content{overflow-y:auto;padding:34px 26px;flex:1}.cdw-modal-content::-webkit-scrollbar{width:8px}.cdw-modal-content::-webkit-scrollbar-track{background:transparent;margin:12px 0}.cdw-modal-content::-webkit-scrollbar-thumb{background:var(--cdw-border);border-radius:4px}.cdw-modal-content::-webkit-scrollbar-thumb:hover{background:#9ca3af}.cdw-header{text-align:center;margin-bottom:26px}.cdw-brand{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:10px}.cdw-logo{width:52px;height:52px;border-radius:50%;object-fit:cover;box-shadow:0 3px 10px rgba(0,0,0,.15);border:3px solid #fff;flex-shrink:0}.cdw-business-name{font-size:21px;font-weight:800;color:var(--cdw-ink);margin:0;letter-spacing:-.02em;line-height:1.2;text-align:left;flex:1;word-break:break-word}.cdw-cta{font-size:14.5px;color:var(--cdw-muted);margin:0;line-height:1.55}.cdw-reconfirm-banner{background:#fef3e2;border:1.5px solid #fcddaa;color:#875706;border-radius:var(--cdw-radius-md);padding:11px 14px;font-size:13.5px;font-weight:600;line-height:1.5;margin:0 0 18px}.cdw-form{display:flex;flex-direction:column;gap:16px}.cdw-field{display:flex;flex-direction:column;gap:7px}.cdw-label{font-size:13.5px;font-weight:600;color:#374151;display:flex;align-items:center;gap:4px}.cdw-required{color:var(--cdw-error)}.cdw-input,.cdw-select{width:100%;padding:12px 14px;border:1.6px solid var(--cdw-border);border-radius:var(--cdw-radius-md);font-size:15px;background:var(--cdw-field-bg);color:var(--cdw-ink);transition:border-color .15s,box-shadow .15s,background .15s;font-family:inherit}.cdw-input::placeholder{color:#9ca3af}.cdw-input:hover,.cdw-select:hover{border-color:#cbd5e1;background:#fff}.cdw-input:focus,.cdw-select:focus{outline:none;border-color:var(--cdw-primary);background:#fff;box-shadow:0 0 0 4px var(--cdw-primary-a14)}.cdw-input:disabled,.cdw-select:disabled{opacity:.55;cursor:not-allowed}.cdw-checkbox-wrapper,.cdw-consent-wrapper{display:flex;align-items:flex-start;gap:11px;padding:12px;background:var(--cdw-field-bg);border:1.6px solid var(--cdw-border);border-radius:var(--cdw-radius-md);cursor:pointer;transition:border-color .15s}.cdw-checkbox-wrapper:hover,.cdw-consent-wrapper:hover{border-color:#cbd5e1}.cdw-checkbox{width:19px;height:19px;margin-top:1px;flex-shrink:0;cursor:pointer}.cdw-checkbox-label,.cdw-consent-text{flex:1;font-size:13.5px;color:#374151;line-height:1.55}.cdw-consent-clickable{text-decoration:underline;text-decoration-color:#c7d2fe;text-underline-offset:2px;cursor:pointer}.cdw-consent-clickable:hover{color:var(--cdw-primary)}.cdw-field-error,.cdw-phone-error{font-size:12.5px;color:var(--cdw-error);display:none;margin-top:-2px}.cdw-field-error.visible,.cdw-phone-error.visible{display:block}.cdw-submit{margin-top:4px;width:100%;padding:14px 22px;border:none;border-radius:var(--cdw-radius-md);font-size:15.5px;font-weight:700;font-family:inherit;color:#fff;cursor:pointer;background:linear-gradient(135deg,var(--cdw-primary) 0%,var(--cdw-primary-light) 100%);box-shadow:0 8px 18px -4px var(--cdw-primary-a45);transition:transform .15s,box-shadow .15s}.cdw-submit:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 10px 22px -4px var(--cdw-primary-a55)}.cdw-submit:active:not(:disabled){transform:translateY(0)}.cdw-submit:disabled{background:#9ca3af;box-shadow:none;cursor:not-allowed}.cdw-spinner{display:inline-block;width:15px;height:15px;margin-right:8px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:cdw-spin .8s linear infinite;vertical-align:-2px}.cdw-loading-state{display:flex;flex-direction:column;align-items:center;gap:16px;padding:40px 0}.cdw-spinner-lg{width:36px;height:36px;margin:0;border-width:3px;border-color:var(--cdw-primary-a25);border-top-color:var(--cdw-primary)}.cdw-loading-text{font-size:14px;font-weight:500;color:var(--cdw-muted);margin:0}.cdw-toast{position:fixed;top:20px;right:20px;max-width:400px;padding:12px 14px;border-radius:var(--cdw-radius-md);font-size:13.5px;display:flex;align-items:flex-start;gap:10px;z-index:${Z + 1};box-shadow:0 10px 25px rgba(0,0,0,.2);animation:cdw-slideInRight .3s ease}.cdw-toast-icon{flex-shrink:0;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px}.cdw-toast-content{flex:1;line-height:1.5}.cdw-toast-error{background:var(--cdw-error-bg);border:1.6px solid var(--cdw-error-border);color:#991b1b}.cdw-toast-error .cdw-toast-icon{background:var(--cdw-error);color:#fff}.cdw-toast-success{background:#e8f6ed;border:1.6px solid #b9e3c9;color:#0a4921}.cdw-toast-success .cdw-toast-icon{background:var(--cdw-success);color:#fff}.cdw-toast-info{background:var(--cdw-primary-tint8);border:1.6px solid var(--cdw-primary-tint25);color:var(--cdw-primary-dark)}.cdw-toast-info .cdw-toast-icon{background:var(--cdw-primary);color:#fff}.cdw-message{padding:12px 14px;border-radius:var(--cdw-radius-md);font-size:13.5px;margin-bottom:16px;display:flex;align-items:flex-start;gap:10px;line-height:1.5;animation:cdw-fade .2s ease}.cdw-message-icon{flex-shrink:0;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px}.cdw-message-content{flex:1}.cdw-message-error{background:var(--cdw-error-bg);border:1.6px solid var(--cdw-error-border);color:#991b1b}.cdw-message-error .cdw-message-icon{background:var(--cdw-error);color:#fff}.cdw-message-success{background:#e8f6ed;border:1.6px solid #b9e3c9;color:#0a4921}.cdw-message-success .cdw-message-icon{background:var(--cdw-success);color:#fff}.cdw-message-info{background:var(--cdw-primary-tint8);border:1.6px solid var(--cdw-primary-tint25);color:var(--cdw-primary-dark)}.cdw-message-info .cdw-message-icon{background:var(--cdw-primary);color:#fff}.cdw-otp{text-align:center;padding:2px 0 0}.cdw-otp-icon{width:58px;height:58px;margin:0 auto 16px;border-radius:50%;background:linear-gradient(135deg,var(--cdw-primary) 0%,var(--cdw-primary-light) 100%);display:flex;align-items:center;justify-content:center;color:#fff;font-size:26px;animation:cdw-pulse 2s infinite}.cdw-otp-title{font-size:18px;font-weight:800;color:var(--cdw-ink);margin:0 0 6px}.cdw-otp-text{font-size:13.5px;color:var(--cdw-muted);line-height:1.55;margin:0 0 22px}.cdw-otp-inputs{display:flex;gap:9px;justify-content:center;margin-bottom:18px}.cdw-otp-input{width:44px;height:54px;font-size:21px;font-weight:700;text-align:center;border:1.6px solid var(--cdw-border);border-radius:12px;background:var(--cdw-field-bg);color:var(--cdw-ink);font-family:inherit;transition:border-color .15s,box-shadow .15s}.cdw-otp-input:focus{outline:none;border-color:var(--cdw-primary);background:#fff;box-shadow:0 0 0 4px var(--cdw-primary-a14)}.cdw-otp-error{font-size:12.5px;color:var(--cdw-error);min-height:18px;margin-bottom:6px}.cdw-otp-spinner-row{min-height:22px;margin-bottom:10px;text-align:center}.cdw-otp-spinner-row .cdw-spinner{width:22px;height:22px;border-width:3px;margin-right:0}.cdw-resend{display:inline-block;color:var(--cdw-primary);font-size:13.5px;font-weight:700;cursor:pointer;margin-top:6px;text-decoration:none}.cdw-resend:hover:not(.cdw-disabled){text-decoration:underline}.cdw-resend.cdw-disabled{color:#9ca3af;cursor:not-allowed}.cdw-otp-back{display:block;color:var(--cdw-muted);font-size:12.5px;font-weight:600;cursor:pointer;margin-top:10px;text-decoration:none}.cdw-otp-back:hover{text-decoration:underline;color:#374151}.cdw-privacy-view{display:flex;flex-direction:column;gap:16px}.cdw-privacy-text{font-size:13.5px;color:#374151;line-height:1.75;white-space:pre-wrap}.cdw-btn-back{align-self:flex-start;background:none;border:none;color:var(--cdw-primary);font-size:13.5px;font-weight:700;cursor:pointer;padding:0;display:inline-flex;align-items:center;gap:6px;font-family:inherit}.cdw-btn-back:hover{text-decoration:underline}.cdw-identity-confirm{text-align:center;padding:4px 0 0}.cdw-identity-msg{font-size:14.5px;color:#374151;margin:0 0 20px;line-height:1.6}.cdw-identity-actions{display:flex;flex-direction:column;gap:10px}.cdw-btn{width:100%;padding:12px 22px;border-radius:var(--cdw-radius-md);font-size:14.5px;font-weight:700;font-family:inherit;cursor:pointer;border:1.6px solid transparent;transition:all .15s}.cdw-btn-primary{background:var(--cdw-primary);color:#fff;border-color:var(--cdw-primary)}.cdw-btn-primary:hover{background:var(--cdw-primary-dark);border-color:var(--cdw-primary-dark)}.cdw-btn-secondary{background:#fff;color:#374151;border-color:var(--cdw-border)}.cdw-btn-secondary:hover{border-color:#cbd5e1;background:var(--cdw-field-bg)}.iti{width:100%}.iti__input,.iti input[type=tel]{width:100%!important;padding:12px 14px!important;padding-left:58px!important;border:1.6px solid var(--cdw-border)!important;border-radius:var(--cdw-radius-md)!important;font-size:15px!important;background:var(--cdw-field-bg)!important;color:var(--cdw-ink)!important;transition:border-color .15s,box-shadow .15s,background .15s!important;height:auto!important;font-family:inherit!important}.iti__input:focus,.iti input[type=tel]:focus{outline:none!important;border-color:var(--cdw-primary)!important;background:#fff!important;box-shadow:0 0 0 4px var(--cdw-primary-a14)!important}.iti__selected-dial-code{display:none!important}.iti--container{z-index:${Z + 10}!important}.iti__dropdown-content{z-index:${Z + 10}!important;max-height:220px!important}.iti__country-list{border-radius:var(--cdw-radius-md)!important;box-shadow:0 10px 25px rgba(0,0,0,.15)!important;border:1px solid var(--cdw-border)!important;max-height:200px!important;overflow-y:auto!important}.iti__search-input{padding:10px 14px!important;font-size:14px!important;height:42px!important;border-bottom:1px solid var(--cdw-border)!important;width:100%!important;box-sizing:border-box!important;outline:none!important}.iti__dial-code{color:var(--cdw-primary)!important}@media(max-width:480px){.cdw-modal-content{padding:26px 18px}.cdw-business-name{font-size:18px}.cdw-logo{width:48px;height:48px}.cdw-otp-input{width:38px;height:48px;font-size:18px}.cdw-toast{left:20px;right:20px;max-width:none}}#cdw-overlay a:focus-visible,#cdw-overlay button:focus-visible,#cdw-overlay input:focus-visible,#cdw-overlay select:focus-visible{outline:2px solid var(--cdw-primary);outline-offset:2px}
            `;
            document.head.appendChild(
                Object.assign(document.createElement('style'), { id: 'cdw-styles', textContent: css })
            );
        },
        
        _shades(hex) {
            const n = hex.length === 4
                ? hex.slice(1).split('').map((c) => c + c).join('')
                : hex.slice(1);
            const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
            const mix = (target, p) => [r, g, b].map((c, i) => Math.round(c * p + target[i] * (1 - p)));
            const hex2 = ([R, G, B]) => '#' + [R, G, B].map((c) => c.toString(16).padStart(2, '0')).join('');
            return {
                '--cdw-primary':       hex,
                '--cdw-primary-dark':  hex2(mix([0, 0, 0], 0.82)),
                '--cdw-primary-light': hex2(mix([255, 255, 255], 0.70)),
                '--cdw-primary-tint8': hex2(mix([255, 255, 255], 0.08)),
                '--cdw-primary-tint25':hex2(mix([255, 255, 255], 0.25)),
                '--cdw-primary-a14':   `rgba(${r},${g},${b},.14)`,
                '--cdw-primary-a25':   `rgba(${r},${g},${b},.25)`,
                '--cdw-primary-a30':   `rgba(${r},${g},${b},.3)`,
                '--cdw-primary-a45':   `rgba(${r},${g},${b},.45)`,
                '--cdw-primary-a55':   `rgba(${r},${g},${b},.55)`,
            };
        },
        // theme = { primaryColor: "#RRGGBB" } 
        applyTheme(theme) {
            const color = theme?.primaryColor;
            if (!color || !/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color)) return;
            const vars = this._shades(color);
            const root = document.documentElement.style;
            for (const key in vars) root.setProperty(key, vars[key]);
        },
    };

    // UI — COMPOSANTS ATOMIQUES
    const UI = {
        /** État de chargement affiché DANS l'overlay, avant bascule vers le formulaire. */
        loadingState() {
            return Dom.el('div', { className: 'cdw-loading-state' },
                Dom.el('div', { className: 'cdw-spinner cdw-spinner-lg' }),
                Dom.el('p', { className: 'cdw-loading-text', textContent: I18n.t('verifying') }),
            );
        },
        overlay() {
            return Dom.el('div', { id: 'cdw-overlay' });
        },
        modal() {
            const content = Dom.el('div', { className: 'cdw-modal-content' });
            const modal   = Dom.el('div', { className: 'cdw-modal' }, content);
            return { modal, content };
        },
        toast(type, text) {
            document.querySelector('.cdw-toast')?.remove();
            const ICONS = { error: '!', success: '✓', info: 'i' };
            const el = Dom.el('div', { className: `cdw-toast cdw-toast-${type}` },
                Dom.el('div', { className: 'cdw-toast-icon', textContent: ICONS[type] ?? 'i' }),
                Dom.el('div', { className: 'cdw-toast-content', textContent: text }),
            );
            document.body.appendChild(el);
            setTimeout(() => {
                el.style.animation = 'cdw-fadeOut .3s ease';
                setTimeout(() => el.remove(), 300);
            }, CONFIG.TOAST_DURATION_MS);
        },
        inlineMessage(container, type, text) {
            container.querySelector('.cdw-message')?.remove();
            const ICONS = { error: '!', success: '✓', info: 'i' };
            container.insertBefore(
                Dom.el('div', { className: `cdw-message cdw-message-${type}` },
                    Dom.el('div', { className: 'cdw-message-icon', textContent: ICONS[type] ?? 'i' }),
                    Dom.el('div', { className: 'cdw-message-content', textContent: text }),
                ),
                container.firstChild,
            );
        },
        header(provision) {
            const logoUrl      = provision?.logo_url ?? null;
            const businessName = provision?.title ?? 'WiFi Public';
            const description  = provision?.description ?? 'Partagez vos coordonnées pour profiter du WiFi gratuit';
            return Dom.el('div', { className: 'cdw-header' },
                Dom.el('div', { className: 'cdw-brand' },
                    logoUrl ? Dom.el('img', { src: logoUrl, className: 'cdw-logo', alt: businessName }) : null,
                    Dom.el('div', { className: 'cdw-business-name', textContent: businessName }),
                ),
                Dom.el('p', { className: 'cdw-cta', textContent: description }),
            );
        },
        _fieldLabel(fieldData) {
            return Dom.el('label', { className: 'cdw-label', htmlFor: `cdw-field-${fieldData.name}` },
                Dom.el('span', { textContent: fieldData.label ?? fieldData.name }),
                fieldData.required ? Dom.el('span', { className: 'cdw-required', textContent: '*' }) : null,
            );
        },
        _booleanField(fieldData) {
            return Dom.el('div', { className: 'cdw-field' },
                Dom.el('label', { className: 'cdw-checkbox-wrapper' },
                    Dom.el('input', { type: 'checkbox', name: fieldData.name, className: 'cdw-checkbox', id: `cdw-field-${fieldData.name}` }),
                    Dom.el('span', { className: 'cdw-checkbox-label', textContent: fieldData.label ?? fieldData.name }),
                ),
            );
        },
        // Champ consent : case ronde cliquable, distincte de 'boolean'. 
        _consentField(fieldData, provision) {
            const hasPolicy = !!(provision?.privacy_policy_text && provision.privacy_policy_text.trim());
            const checkbox = Dom.el('input', {
                type: 'checkbox', name: fieldData.name, className: 'cdw-checkbox cdw-consent-checkbox',
                id: `cdw-field-${fieldData.name}`, required: !!fieldData.required,
            });
            const text = Dom.el('span', {
                className: hasPolicy ? 'cdw-consent-text cdw-consent-clickable' : 'cdw-consent-text',
                textContent: fieldData.label ?? fieldData.name,
            });
            if (hasPolicy) text.dataset.cdwPrivacyTrigger = 'true';
            return Dom.el('div', { className: 'cdw-field' },
                Dom.el('div', { className: 'cdw-checkbox-wrapper cdw-consent-wrapper' }, checkbox, text),
            );
        },
        // Vue plein-cadre du texte de confidentialité, avec bouton retour.
        privacyPolicyView(text, onBack) {
            const backBtn = Dom.el('button', { type: 'button', className: 'cdw-btn-back', textContent: '← Retour' });
            backBtn.addEventListener('click', onBack);
            return Dom.el('div', { className: 'cdw-privacy-view' }, backBtn,
                Dom.el('div', { className: 'cdw-privacy-text', textContent: text }),
            );
        },
        _phoneField(fieldData) {
            const error = Dom.el('div', { className: 'cdw-field-error cdw-phone-error', textContent: 'Numéro de téléphone invalide' });
            error.dataset.field = fieldData.name;
            return Dom.el('div', { className: 'cdw-field' },
                this._fieldLabel(fieldData),
                Dom.el('input', { id: `cdw-field-${fieldData.name}`, name: fieldData.name, type: 'tel', className: 'cdw-input cdw-phone-input', required: !!fieldData.required }),
                error,
            );
        },
        _selectField(fieldData) {
            const sel = Dom.el('select', { className: 'cdw-select', name: fieldData.name, id: `cdw-field-${fieldData.name}`, required: !!fieldData.required });
            sel.appendChild(Dom.el('option', { value: '', textContent: 'Sélectionnez une option', disabled: true, selected: true }));
            (fieldData.choices ?? []).forEach((c) => sel.appendChild(Dom.el('option', { value: c, textContent: c })));
            return sel;
        },
        _inputField(fieldData) {
            const TYPE_MAP = {
                email:  { type: 'email',  placeholder: 'exemple@email.com', autocomplete: 'email' },
                number: { type: 'number', placeholder: 'Entrez un nombre' },
            };
            const cfg = TYPE_MAP[fieldData.type] ?? {
                type: 'text',
                placeholder: fieldData.placeholder ?? `Entrez ${(fieldData.label ?? fieldData.name).toLowerCase()}`,
                autocomplete: 'off',
            };
            return Dom.el('input', { ...cfg, className: 'cdw-input', name: fieldData.name, id: `cdw-field-${fieldData.name}`, required: !!fieldData.required });
        },
        formField(fieldData, provision) {
            if (fieldData.type === 'boolean') return this._booleanField(fieldData);
            if (fieldData.type === 'consent') return this._consentField(fieldData, provision);
            if (fieldData.type === 'phone')   return this._phoneField(fieldData);
            const inputEl = fieldData.type === 'choice' ? this._selectField(fieldData) : this._inputField(fieldData);
            const error = Dom.el('div', { className: 'cdw-field-error' });
            error.dataset.field = fieldData.name;
            return Dom.el('div', { className: 'cdw-field' }, this._fieldLabel(fieldData), inputEl, error);
        },
        form(schema, provision) {
            const buttonLabel = provision?.button_label ?? 'Accéder au WiFi';
            const submitBtn = Dom.el('button', { type: 'submit', className: 'cdw-submit', textContent: buttonLabel });
            const form = Dom.el('form', { className: 'cdw-form', noValidate: true }, ...(schema.fields ?? []).map((f) => this.formField(f, provision)), submitBtn);
            const container = Dom.el('div', {}, this.header(provision), form);
            return { container, form, submitBtn, buttonLabel };
        },
        verificationView(onComplete, { onBack } = {}) {
            const errorZone   = Dom.el('div', { className: 'cdw-otp-error' });
            const spinnerZone = Dom.el('div', { className: 'cdw-otp-spinner-row', style: 'display:none' },
                Dom.el('span', { className: 'cdw-spinner', style: 'border-color:var(--cdw-primary-a30);border-top-color:var(--cdw-primary)' }),
            );
            const codeInputs = Dom.el('div', { className: 'cdw-otp-inputs' });
            const showError = (msg) => {
                errorZone.textContent = msg;
                errorZone.classList.add('visible');
                spinnerZone.style.display = 'none';
                this.clearOtpInputs(codeInputs);
            };
            const setLoading = (loading) => {
                spinnerZone.style.display = loading ? 'block' : 'none';
                errorZone.classList.remove('visible');
                Array.from(codeInputs.children).forEach((inp) => { inp.disabled = loading; });
            };
            for (let idx = 0; idx < CONFIG.OTP_LENGTH; idx++) {
                const input = Dom.el('input', { type: 'text', className: 'cdw-otp-input', maxLength: 1, pattern: '[0-9]', inputMode: 'numeric' });
                input.dataset.index = idx;
                input.addEventListener('input', (e) => {
                    e.target.value = e.target.value.replace(/\D/g, '');
                    errorZone.classList.remove('visible');
                    if (e.target.value.length !== 1) return;
                    if (idx < CONFIG.OTP_LENGTH - 1) { codeInputs.children[idx + 1].focus(); return; }
                    const code = Array.from(codeInputs.children).map((i) => i.value).join('');
                    if (code.length === CONFIG.OTP_LENGTH) { setLoading(true); onComplete(code, showError, setLoading); }
                });
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Backspace' && !e.target.value && idx > 0) codeInputs.children[idx - 1].focus();
                });
                codeInputs.appendChild(input);
            }
            const resendLink = Dom.el('a', { href: '#', className: 'cdw-resend', textContent: 'Renvoyer le code' });
            const backLink = onBack
                ? Dom.el('a', { href: '#', className: 'cdw-otp-back', textContent: 'Reprendre le formulaire' })
                : null;
            if (backLink) backLink.addEventListener('click', (e) => { e.preventDefault(); onBack(); });
            const container = Dom.el('div', { className: 'cdw-otp' },
                Dom.el('div', { className: 'cdw-otp-icon', textContent: '📱' }),
                Dom.el('h2', { className: 'cdw-otp-title', textContent: 'Vérification requise' }),
                Dom.el('p', { className: 'cdw-otp-text', textContent: 'Un code de vérification a été envoyé. Veuillez le saisir ci-dessous.' }),
                codeInputs, errorZone, spinnerZone, resendLink, backLink,
            );
            return { container, codeInputs, resendLink, backLink };
        },
        identityConfirmView(onConfirm, onDeny) {
            const btnYes = Dom.el('button', { type: 'button', className: 'cdw-btn cdw-btn-primary', textContent: "Oui, c'est moi" });
            const btnNo  = Dom.el('button', { type: 'button', className: 'cdw-btn cdw-btn-secondary', textContent: "Non, ce n'est pas moi" });
            btnYes.addEventListener('click', onConfirm);
            btnNo.addEventListener('click', onDeny);
            return Dom.el('div', { className: 'cdw-identity-confirm' },
                Dom.el('p', { className: 'cdw-identity-msg', textContent: 'Ce contact est déjà associé à un compte. Est-ce bien vous ?' }),
                Dom.el('div', { className: 'cdw-identity-actions' }, btnYes, btnNo),
            );
        },
        clearOtpInputs(codeInputs) {
            Array.from(codeInputs.children).forEach((inp) => { inp.value = ''; inp.disabled = false; });
            codeInputs.children[0]?.focus();
        },
        setButtonLoading(btn, loading, label) {
            btn.disabled = loading;
            btn.innerHTML = loading ? `<span class="cdw-spinner"></span>${label}` : label;
        },
        showFieldErrors(form, payloadErrors) {
            let hasErrors = false;
            for (const [field, msg] of Object.entries(payloadErrors)) {
                const el = form.querySelector(`.cdw-field-error[data-field="${field}"]`);
                if (!el) continue;
                el.textContent = Array.isArray(msg) ? msg.join(' ') : msg;
                el.classList.add('visible');
                hasErrors = true;
            }
            return hasErrors;
        },
        clearFieldErrors(form) {
            form.querySelectorAll('.cdw-field-error').forEach((el) => {
                el.textContent = '';
                el.classList.remove('visible');
            });
        },
    };

    // PHONE CONTROLLER
    const PhoneController = {
        async _detectCountry() {
            try {
                const data = await Promise.race([
                    fetch('https://ipapi.co/json').then((r) => r.json()),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CONFIG.GEO_TIMEOUT_MS)),
                ]);
                return data?.country_code ?? 'bj';
            } catch {
                return 'bj';
            }
        },
        async init(phoneInput) {
            if (!phoneInput || !window.intlTelInput) return null;
            const iti = window.intlTelInput(phoneInput, {
                initialCountry: 'auto',
                geoIpLookup: (cb) => this._detectCountry().then(cb),
                countryOrder: CONFIG.COUNTRY_ORDER,
                separateDialCode: false,
                showSelectedDialCode: false,
                allowDropdown: true,
                // Sort la liste des pays vers document.body (la modal a overflow-y:auto et la tronquerait sinon) ;
                // le repositionnement ci-dessous évite qu'elle dépasse le bas de l'écran.
                dropdownContainer: document.body,
            });
            phoneInput.addEventListener('open:countrydropdown', () => {
                // Double rAF : la 1re frame laisse intl-tel-input terminer son positionnement, la 2e relit une mise en page à jour (évite un forced reflow).
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        const dropdown = document.querySelector('.iti__dropdown-content');
                        if (!dropdown) return;
                        const overflow = dropdown.getBoundingClientRect().bottom - window.innerHeight + 10;
                        if (overflow > 0) dropdown.style.top = `${parseFloat(dropdown.style.top || '0') - overflow}px`;
                    });
                });
            });
            return iti;
        },
        attachValidation(phoneInput, iti) {
            if (!phoneInput || !iti) return;
            const errorEl = phoneInput.closest('.cdw-field')?.querySelector('.cdw-phone-error');
            if (!errorEl) return;
            phoneInput.addEventListener('blur', () => {
                if (!phoneInput.value) return;
                errorEl.classList.toggle('visible', !iti.isValidNumber());
            });
            phoneInput.addEventListener('input', () => errorEl.classList.remove('visible'));
        },
        getValue(input, iti) {
            return iti ? iti.getNumber() : (input?.value ?? null);
        },
        validate(form, iti) {
            if (!iti || iti.isValidNumber()) return true;
            const errorEl = form.querySelector('.cdw-phone-error');
            if (errorEl) {
                errorEl.textContent = 'Veuillez saisir un numéro de téléphone valide.';
                errorEl.classList.add('visible');
            }
            return false;
        },
    };

    // RESEND CONTROLLER
    const ResendController = {
        // resendFn encapsule l'appel réseau pour renvoyer le code (/resend/ avec client_token, ou resoumission de /submit/ sans code — cas du Chemin A, sans client_token).
        attach(resendLink, resendFn, codeInputs) {
            resendLink.addEventListener('click', async (e) => {
                e.preventDefault();
                if (resendLink.classList.contains('cdw-disabled')) return;
                resendLink.classList.add('cdw-disabled');
                const label = resendLink.textContent;
                resendLink.textContent = 'Envoi en cours…';
                try {
                    await resendFn();
                    resendLink.textContent = label;
                    UI.toast('success', 'Nouveau code envoyé');
                    UI.clearOtpInputs(codeInputs);
                    setTimeout(() => resendLink.classList.remove('cdw-disabled'), CONFIG.RESEND_COOLDOWN_MS);
                } catch (err) {
                    resendLink.classList.remove('cdw-disabled');
                    resendLink.textContent = label;
                    UI.toast('error', err.message);
                }
            });
        },
    };

    // MODAL CONTROLLER
    const ModalController = {
        mount(overlay, modal, content) {
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            Dom.lockScroll();
            Dom.revealPage(); // l'overlay bloque désormais l'interaction, la page peut être révélée
        },
        dismiss(overlay, callback) {
            Dom.unlockScroll();
            overlay.style.animation = `cdw-fadeOut ${CONFIG.ANIMATION_MS}ms ease`;
            setTimeout(() => { overlay.remove(); callback?.(); }, CONFIG.ANIMATION_MS);
        },
        showVerification(modalContent, provision, clientToken, { onSuccess, onClose }) {
            const verif = UI.verificationView(async (code, showError) => {
                try {
                    await PortalApi.confirm(clientToken, code);
                    onSuccess();
                } catch (err) {
                    (err.status === 400 || err.status === 422)
                        ? showError(err.message ?? 'Code incorrect, veuillez réessayer.')
                        : onClose();
                }
            });
            Dom.replace(modalContent, UI.header(provision), verif.container);
            verif.codeInputs.children[0]?.focus();
            ResendController.attach(verif.resendLink, () => PortalApi.resend(clientToken), verif.codeInputs);
        },
        // Chemin A — conflit d'identité résolu par OTP (le formulaire ne matche pas le nom enregistré, mais le client a déjà un téléphone et l'OTP est actif).
        // Pas de client_token à ce stade : le code se vérifie en resoumettant /submit/ avec verification_code, pas via /confirm/.
        showOtpIdentityConflict(modalContent, provision, submitBody, { onClose, onRestart, onExhausted }) {
            const MAX_ATTEMPTS = 3;
            let attempts = 0;

            const verif = UI.verificationView(async (code, showError) => {
                try {
                    const result = await PortalApi.submit(submitBody.public_key, submitBody.mac_address, submitBody.payload, submitBody.client_token, { verificationCode: code });
                    if (result.rejected) {
                        attempts += 1;
                        if (attempts >= MAX_ATTEMPTS) { onExhausted(); return; }
                        showError(`${result.message || 'Code de vérification invalide.'} Il vous reste ${MAX_ATTEMPTS - attempts} tentative(s).`);
                        return;
                    }
                    if (result.client_token) Storage.set(`token_${submitBody.public_key}`, result.client_token);
                    onClose(provision?.success_message || 'Informations enregistrées avec succès.');
                } catch (err) {
                    if (err.status === 400 || err.status === 422) {
                        attempts += 1;
                        if (attempts >= MAX_ATTEMPTS) { onExhausted(); return; }
                        showError(`${err.message ?? 'Code incorrect, veuillez réessayer.'} Il vous reste ${MAX_ATTEMPTS - attempts} tentative(s).`);
                        return;
                    }
                    onClose();
                }
            }, { onBack: () => onRestart() });

            Dom.replace(modalContent, UI.header(provision), verif.container);
            verif.codeInputs.children[0]?.focus();
            // Renvoi = resoumission de /submit/ sans code : redéclenche send_verification_code() côté backend (Chemin A).
            // Ne compte pas comme une tentative — seul un code effectivement saisi et refusé en compte une.
            ResendController.attach(verif.resendLink, () => PortalApi.submit(submitBody.public_key, submitBody.mac_address, submitBody.payload, submitBody.client_token), verif.codeInputs);
        },
        showIdentityConflict(modalContent, provision, submitBody, { onClose, onRestore }) {
            const view = UI.identityConfirmView(
                async () => {
                    try {
                        const result = await PortalApi.submit(submitBody.public_key, submitBody.mac_address, submitBody.payload, submitBody.client_token, { identityConfirmed: true });
                        if (result.client_token) Storage.set(`token_${submitBody.public_key}`, result.client_token);
                        onClose(provision?.success_message || 'Informations enregistrées avec succès.');
                    } catch { onClose(); }
                },
                () => onRestore(),
            );
            Dom.replace(modalContent, UI.header(provision), view);
        },
    };

    // FORM CONTROLLER
    const FormController = {
        serialize(form, iti) {
            const payload = {};
            for (const [key, value] of new FormData(form).entries()) {
                const input = form.querySelector(`[name="${key}"]`);
                if (!input) continue;
                if (input.classList.contains('cdw-phone-input')) payload[key] = PhoneController.getValue(input, iti);
                else if (input.type === 'checkbox') payload[key] = input.checked;
                else if (input.type === 'number') payload[key] = value ? Number(value) : null;
                else payload[key] = value || null;
            }
            return payload;
        },
        attachSubmitHandler({ formData, modalContent, overlay, provision, publicKey, macAddress, storedToken, iti }) {
            formData.form.addEventListener('submit', async (e) => {
                e.preventDefault();
                UI.clearFieldErrors(formData.form);
                if (!PhoneController.validate(formData.form, iti)) return;
                if (!formData.form.checkValidity()) { formData.form.reportValidity(); return; }
                UI.setButtonLoading(formData.submitBtn, true, 'Envoi en cours…');
                const payload    = this.serialize(formData.form, iti);
                const submitBody = { public_key: publicKey, mac_address: macAddress, payload, client_token: storedToken };
                const close = (msg) => ModalController.dismiss(overlay, () => { if (msg) UI.toast('success', msg); });
                // Remet le modal sur le formulaire, vidé, prêt pour une nouvelle tentative — utilisé par les 2 issues négatives des sous-flux de conflit d'identité ("Non", ou code OTP invalide).
                const resetToForm = (msg) => {
                    Dom.replace(modalContent, formData.container);
                    formData.form.reset();
                    UI.setButtonLoading(formData.submitBtn, false, formData.buttonLabel);
                    if (msg) UI.inlineMessage(formData.container, 'error', msg);
                };
                try {
                    const result = await PortalApi.submit(publicKey, macAddress, payload, storedToken);
                    if (result.client_token) Storage.set(`token_${publicKey}`, result.client_token);
                    const successMsg = provision?.success_message || 'Merci ! Vos informations ont été enregistrées.';
                    if (result.verification_required) {
                        if (result.client_token) {
                            // Nouveau client, OTP standard : le client existe déjà en base, la vérification se fait via /confirm/.
                            if (result.message) UI.toast('info', result.message);
                            ModalController.showVerification(modalContent, provision, result.client_token, {
                                onSuccess: () => close(successMsg),
                                onClose:   () => ModalController.dismiss(overlay),
                            });
                            return;
                        }
                        if (result.method === 'otp') {
                            // Chemin A : conflit d'identité résolu par OTP, sans client_token — vérification en resoumettant /submit/.
                            if (result.message) UI.toast('info', result.message);
                            ModalController.showOtpIdentityConflict(modalContent, provision, submitBody, {
                                onClose:     (msg) => close(msg),
                                onRestart:   (msg) => resetToForm(msg),
                                onExhausted: () => ModalController.dismiss(overlay),
                            });
                            return;
                        }
                        // method === 'declarative' : Chemin B, confirmation "Oui/Non".
                        ModalController.showIdentityConflict(modalContent, provision, submitBody, {
                            onClose:   (msg) => close(msg),
                            onRestore: () => resetToForm(),
                        });
                        return;
                    }
                    close(successMsg);
                } catch (err) {
                    // Blocage métier (abonnement lead_capture insuffisant) renvoyé en HTTP 403.
                    if (err.status === 403) {
                        UI.setButtonLoading(formData.submitBtn, false, formData.buttonLabel);
                        UI.inlineMessage(formData.container, 'error', err.message || 'Service temporairement indisponible.');
                        return;
                    }
                    if (!err.status || err.status >= 500) { ModalController.dismiss(overlay); return; }
                    UI.setButtonLoading(formData.submitBtn, false, formData.buttonLabel);
                    const payloadErrors = err.data?.payload;
                    const hasFieldErrors = (
                        err.status === 400 && payloadErrors && typeof payloadErrors === 'object' &&
                        !Array.isArray(payloadErrors) && UI.showFieldErrors(formData.form, payloadErrors)
                    );
                    if (!hasFieldErrors) {
                        UI.inlineMessage(formData.container, 'error',
                            err.status === 404 ? "Service introuvable. Contactez l'administrateur." : (err.message ?? 'Une erreur est survenue'));
                    }
                }
            });
        },
    };

    // ORCHESTRATEUR
    /** Monte l'overlay avec un état de chargement visible, retourne les refs DOM. */
    function mountLoadingOverlay() {
        const { modal, content } = UI.modal();
        const overlay = UI.overlay();
        Dom.replace(content, UI.loadingState());
        ModalController.mount(overlay, modal, content);
        return { overlay, modal, content };
    }
    /** Bascule l'overlay déjà monté du chargement vers le formulaire (ou l'inverse en cas d'échec). */
    async function renderCollectionForm({ overlay, content, provision, publicKey, macAddress, storedToken, reconfirmation = false }) {
        Styles.applyTheme(provision.theme);
        if (provision.language) I18n.setLang(provision.language);
        Loader.style(CONFIG.ITI.CSS);
        const itiScriptPromise = Loader.script(CONFIG.ITI.JS);
        const hasPhone = (provision.schema?.fields ?? []).some((f) => f.type === 'phone');
        if (hasPhone) await itiScriptPromise;
        const formData = UI.form(provision.schema ?? { fields: [] }, provision);
        Dom.replace(content, formData.container);
        // Cas exceptionnel (section 5 de la spec) : message fixe, non configurable,
        // pour éviter la confusion d'un client qui a l'impression d'avoir déjà rempli ce formulaire.
        if (reconfirmation) UI.inlineMessage(formData.container, 'info', I18n.t('reconfirmMessage'));
        const phoneInput = formData.form.querySelector('.cdw-phone-input');
        const iti        = await PhoneController.init(phoneInput);
        PhoneController.attachValidation(phoneInput, iti);
        formData.form.addEventListener('click', (e) => {
            if (!e.target.closest('[data-cdw-privacy-trigger]')) return;
            Dom.replace(content, UI.privacyPolicyView(provision.privacy_policy_text, () => {
                Dom.replace(content, formData.container);
            }));
        });
        FormController.attachSubmitHandler({
            formData, modalContent: content, overlay, provision,
            publicKey, macAddress, storedToken, iti,
        });
    }
    /** Referme l'overlay (s'il existe) et rend le portail natif utilisable. */
    function releasePortal(overlay) {
        if (overlay) ModalController.dismiss(overlay);
        Dom.unlockScroll();
        Dom.revealPage();
    }
    // Flux A — jeton local présent : aucun overlay, accès immédiat. L'appel fusionné tourne quand même en arrière-plan pour confirmer la validité du jeton.
    async function revalidateInBackground(publicKey, macAddress, storedToken) {
        let result;
        try {
            result = await PortalApi.identify(publicKey, macAddress, storedToken);
        } catch (err) {
            Log.warn('Revalidation en arrière-plan impossible :', err);
            return; // silencieux : le client a déjà un accès immédiat, rien à changer visuellement
        }
        if (result.recognized) {
            if (result.client_token && result.client_token !== storedToken) Storage.set(`token_${publicKey}`, result.client_token);
            // is_verified n'a aujourd'hui aucun rôle côté widget : un client reconnu passe, vérifié ou non (décision produit, spec §4.3/6bis).
            Log.info('Client reconnu en arrière-plan.', { is_verified: result.is_verified });
            return;
        }
        if (!result.form_display_enabled) return; // widget désactivé par le gérant entre-temps
        // Jeton local infirmé par le serveur : overlay affiché après coup (cas exceptionnel).
        Log.info('Jeton local infirmé par le serveur, collecte affichée après coup.');
        const { modal, content } = UI.modal();
        const overlay = UI.overlay();
        ModalController.mount(overlay, modal, content);
        await renderCollectionForm({ overlay, content, provision: result, publicKey, macAddress, storedToken, reconfirmation: true });
    }
    // Flux B — jeton local absent : overlay bloquant, chargement le temps de l'appel fusionné, puis formulaire. Garde-fou : si l'appel ne répond pas à temps, on laisse passer le client plutôt que de bloquer indéfiniment.
    async function runNewClientFlow(publicKey, macAddress) {
        const { overlay, content } = mountLoadingOverlay();
        let settled = false;
        const guard = setTimeout(() => {
            if (settled) return;
            settled = true;
            Log.warn('Délai max dépassé pour l\'appel fusionné, portail débloqué (lead manqué).');
            releasePortal(overlay);
        }, CONFIG.MAX_WAIT_MS);
        let result;
        try {
            result = await PortalApi.identify(publicKey, macAddress, null);
        } catch (err) {
            clearTimeout(guard);
            if (settled) return; // le garde-fou a déjà libéré le portail
            settled = true;
            Log.error('Provisioning impossible :', err);
            releasePortal(overlay);
            return;
        }
        clearTimeout(guard);
        if (settled) return; // le garde-fou a déjà libéré le portail entre-temps
        if (result.recognized) {
            // Rare : reconnu par MAC/serveur alors qu'aucun jeton n'était stocké localement.
            if (result.client_token) Storage.set(`token_${publicKey}`, result.client_token);
            Log.info('Client reconnu.', { is_verified: result.is_verified });
            releasePortal(overlay);
            return;
        }
        if (!result.form_display_enabled) { releasePortal(overlay); return; } // widget désactivé par le gérant : pas de collecte
        await renderCollectionForm({ overlay, content, provision: result, publicKey, macAddress, storedToken: null });
    }
    async function init(options = {}) {
        const publicKey   = options.publicKey ?? Device.resolvePublicKey(options);
        const macAddress  = Device.resolveMAC();
        const storedToken = 'storedToken' in options ? options.storedToken : Storage.get(`token_${publicKey}`);
        if (!publicKey)  { Log.error('Clé publique manquante.');  Dom.revealPage(); return; }
        if (!macAddress) { Log.error('Adresse MAC introuvable.'); Dom.revealPage(); return; }
        Styles.inject();
        if (storedToken) { revalidateInBackground(publicKey, macAddress, storedToken); return; } // pas de await : ne bloque rien
        await runNewClientFlow(publicKey, macAddress);
    }

    // BOOTSTRAP — décision locale synchrone, sans appel réseau : détermine le flux emprunté par init().
    const _earlyPublicKey   = Device.resolvePublicKey();
    const _earlyStoredToken = _earlyPublicKey ? Storage.get(`token_${_earlyPublicKey}`) : null;
    window.CoreDataWidget = Object.freeze({ init, version: '5.0.0' });
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => init({ publicKey: _earlyPublicKey, storedToken: _earlyStoredToken }), { once: true });
    } else {
        init({ publicKey: _earlyPublicKey, storedToken: _earlyStoredToken });
    }
})(window, document);
