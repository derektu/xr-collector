import type { SourceDeclarations } from '../../shared/sources/source-registry.js';
import { API_ROUTES, routePath } from '../../shared/api/api-routes.js';
import { CollectorError } from '../../shared/lib/collector-error.js';
import type { SourceTypeInfo, UrlRecognition } from '../../shared/sources/source-info-types.js';
import type { SubscriptionPreview } from '../../shared/subscriptions/subscription-types.js';
import type { SourcePluginDeclaration } from '../../shared/sources/source-contract.js';

const BARE_HOST_ADDRESS = /^[^\s/@:]+\.[^\s/]+(\/\S*)?$/u;

export interface RecognitionContext {
  previewSubscription(type: string, url: string): Promise<SubscriptionPreview>;
}

export interface SourceTypeDeclaration extends SourceTypeInfo {
  owns(input: string, url: URL | null): boolean;
  recognize(input: string, context: RecognitionContext): Promise<UrlRecognition>;
}

export function recognizingSourceType(declaration: SourcePluginDeclaration): SourceTypeDeclaration {
  const type = declaration.id;
  const single = declaration.kinds.find((kind) => kind.capability === 'single');
  const subscribing = declaration.kinds.find((kind) => kind.capability === 'subscription');
  return {
    ...sourceTypeInfo(declaration),
    owns: (input, url) => declaration.owns(input, url),
    async recognize(input, context) {
      let classified;
      try {
        classified = declaration.classify(input);
      } catch (error) {
        if (error instanceof CollectorError) return unsupported(input, error.message, type);
        throw error;
      }
      if (classified.kind === 'item') {
        const { ref } = classified;
        return {
          ...base('ready', ref.url),
          sourceType: type, kind: single?.id ?? null, kindLabel: single?.label ?? null,
          target: { id: ref.key, title: null, url: ref.url },
          actions: [{
            id: 'collect', label: `收集${declaration.item.noun}`, primary: true,
            request: { method: API_ROUTES.collectItem.method, path: API_ROUTES.collectItem.path, body: { url: ref.url } },
          }],
        };
      }
      const kind = subscribing?.id ?? null;
      const kindLabel = subscribing?.label ?? null;
      let preview: SubscriptionPreview;
      try {
        preview = await context.previewSubscription(type, classified.url);
      } catch (error) {
        if (error instanceof CollectorError) {
          const status = error.code === 'invalid_subscription' ? 'unsupported' : 'unavailable';
          return { ...base(status, classified.url), sourceType: type, kind, kindLabel, message: error.message };
        }
        throw error;
      }
      const { target, subscription } = preview;
      const targetNoun = declaration.subscription?.targetNoun ?? '';
      const actions: UrlRecognition['actions'] = !subscription
        ? [{ id: 'subscribe', label: `訂閱${targetNoun}`, primary: true, request: { method: API_ROUTES.subscribe.method, path: API_ROUTES.subscribe.path, body: { url: target.url } } }]
        : !subscription.enabled
          ? [{ id: 'resume', label: '恢復訂閱', primary: true, request: { method: API_ROUTES.updateSubscription.method, path: routePath(API_ROUTES.updateSubscription, { type, id: target.id }), body: { enabled: true } } }]
          : [];
      return {
        ...base('ready', target.url),
        sourceType: type, kind, kindLabel,
        target: { id: target.id, title: target.title, url: target.url },
        subscription: subscription ? { id: target.id, enabled: subscription.enabled, settings: subscription.settings } : null,
        settings: declaration.subscription?.defaults ?? null,
        autoCollection: preview.autoCollection,
        actions,
      };
    },
  };
}

export function sourceTypeDeclarations(sources: SourceDeclarations): SourceTypeDeclaration[] {
  return sources.list.map(recognizingSourceType);
}

export function sourceTypeInfo(declaration: SourceTypeInfo): SourceTypeInfo {
  const { id, label, icon, kinds, requiresLogin, settings } = declaration;
  return { id, label, icon, kinds, requiresLogin, settings };
}

export async function recognizeUrl(input: string, declarations: SourceTypeDeclaration[], context: RecognitionContext): Promise<UrlRecognition> {
  const { input: trimmed, url, owner } = addressOwner(input, declarations);
  if (!owner) {
    return unsupported(trimmed, url ? '目前還不支援這個網站的網址。' : '請貼上完整網址，例如 https:// 開頭的網址。', null);
  }
  if (owner.requiresLogin) {
    return {
      ...base('login_required', trimmed),
      sourceType: owner.id,
      login: { sourceType: owner.id, label: owner.label, message: `需要先登入 ${owner.label} 才能收集這個網址的內容。` },
    };
  }
  return owner.recognize(trimmed, context);
}

export function addressOwner<T extends Pick<SourceTypeDeclaration, 'owns'>>(input: string, declarations: readonly T[]): { input: string; url: URL | null; owner: T | undefined } {
  const trimmed = input.trim();
  const url = absoluteUrl(trimmed);
  const owner = declarations.find((declaration) => declaration.owns(trimmed, url));
  if (!owner && !url) {
    const assumed = assumeHttps(trimmed);
    const assumedOwner = assumed ? declarations.find((declaration) => declaration.owns(assumed.input, assumed.url)) : undefined;
    if (assumed && assumedOwner) return { ...assumed, owner: assumedOwner };
  }
  return { input: trimmed, url, owner };
}

function assumeHttps(input: string): { input: string; url: URL } | null {
  if (!BARE_HOST_ADDRESS.test(input)) return null;
  const withScheme = `https://${input}`;
  const url = absoluteUrl(withScheme);
  return url ? { input: withScheme, url } : null;
}

function absoluteUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function base(status: UrlRecognition['status'], url: string): UrlRecognition {
  return {
    status, sourceType: null, kind: null, kindLabel: null, url, target: null,
    subscription: null, settings: null, autoCollection: null, actions: [], login: null, message: null,
  };
}

function unsupported(url: string, message: string, sourceType: UrlRecognition['sourceType']): UrlRecognition {
  return { ...base('unsupported', url), sourceType, message };
}
