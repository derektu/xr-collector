import { sourceDeclarations } from '../core/source-registry.js';
import {
  CollectorError,
  type SourceTypeInfo,
  type SubscriptionPreview,
  type UrlRecognition,
} from '../core/types.js';
import type { SourcePluginDeclaration } from '../plugins/types.js';

/** Services a source type may call while recognizing an address. */
export interface RecognitionContext {
  /** Resolves a subscription address of a type and reports its subscription state and the settings it uses or would start with. */
  previewSubscription(type: string, url: string): Promise<SubscriptionPreview>;
}

/**
 * A source type as the Sources page, its filters and the Add dialog see it: the addresses it owns
 * and what can be done with one.
 */
export interface SourceTypeDeclaration extends SourceTypeInfo {
  /** Whether the input belongs to this type; decided by syntax alone. */
  owns(input: string, url: URL | null): boolean;
  /** What an owned address is and what can be done with it. Not called when the type requires login. */
  recognize(input: string, context: RecognitionContext): Promise<UrlRecognition>;
}

/**
 * The recognition of a source plugin's addresses: a single item offers to collect it, and a
 * subscription address is resolved now to offer subscribing, or resuming a paused subscription.
 * The actions call the type's own routes under `/api/<type>/`.
 */
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
            request: { method: 'POST', path: `/api/${type}/collect`, body: { url: ref.url } },
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
          return { ...base('unavailable', classified.url), sourceType: type, kind, kindLabel, message: error.message };
        }
        throw error;
      }
      const { channel: target, subscription } = preview;
      const targetNoun = declaration.subscription?.targetNoun ?? '';
      const actions: UrlRecognition['actions'] = !subscription
        ? [{ id: 'subscribe', label: `訂閱${targetNoun}`, primary: true, request: { method: 'POST', path: `/api/${type}/channels`, body: { url: target.url } } }]
        : !subscription.enabled
          ? [{ id: 'resume', label: '恢復訂閱', primary: true, request: { method: 'PATCH', path: `/api/${type}/channels/${encodeURIComponent(target.id)}`, body: { enabled: true } } }]
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

/** Every registered source type, in display order, as address recognition uses it. */
export function sourceTypeDeclarations(): SourceTypeDeclaration[] {
  return sourceDeclarations().map(recognizingSourceType);
}

/** The serializable part of a declaration that `GET /api/source-types` returns. */
export function sourceTypeInfo(declaration: SourceTypeInfo): SourceTypeInfo {
  const { id, label, icon, kinds, requiresLogin, settings } = declaration;
  return { id, label, icon, kinds, requiresLogin, settings };
}

/**
 * Recognizes a pasted address with the first declaration that owns it. Addresses no type owns are
 * `unsupported`; a type that requires login answers `login_required` without contacting the source.
 */
export async function recognizeUrl(input: string, declarations: SourceTypeDeclaration[], context: RecognitionContext): Promise<UrlRecognition> {
  let trimmed = input.trim();
  let url = absoluteUrl(trimmed);
  let owner = declarations.find((declaration) => declaration.owns(trimmed, url));
  if (!owner && !url) {
    // Addresses are often copied without their scheme (example.com/page). Such an input is read
    // as https:// only when a type owns the result; any other bare string stays unsupported.
    const withScheme = `https://${trimmed}`;
    const candidate = /^[^\s/@:]+\.[^\s/]+(\/\S*)?$/u.test(trimmed) ? absoluteUrl(withScheme) : null;
    const candidateOwner = candidate ? declarations.find((declaration) => declaration.owns(withScheme, candidate)) : undefined;
    if (candidate && candidateOwner) { trimmed = withScheme; url = candidate; owner = candidateOwner; }
  }
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

function absoluteUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    // Not an absolute URL; a type may still own it, such as a handle.
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
