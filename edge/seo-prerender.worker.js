/*
  seo-prerender.worker.js — EDGE PRERENDER for social/search crawlers (Layer 2).

  ── Status: SCAFFOLD. Not deployed. Uses MOCK_POSTS / MOCK_CREATORS below. ──

  WHY THIS EXISTS
  ---------------
  app.vopenworld.com is a single-spa SPA: the article/creator content is rendered
  by JavaScript after load. Social crawlers (facebookexternalhit, Twitterbot,
  Slackbot, LinkedInBot, Discordbot, WhatsApp, Telegram, Zalo…) DO NOT run JS, so
  the Open Graph tags injected client-side by useSeo() never reach them — share
  previews would show the generic shell. Googlebot does render JS but rewards a
  fast static <head>.

  This Worker sits in front of app.vopenworld.com. For crawler requests to
  /experiences/:slug and /experiences/creator/:id it:
    1. resolves the post/creator (MOCK now → bff-api later),
    2. fetches the real shell HTML from the origin,
    3. rewrites <head> with the correct title + OG/Twitter + JSON-LD,
    4. returns the patched HTML.
  Human/browser requests are passed through untouched so the SPA behaves normally.

  DEPLOY (later)
  --------------
  - Requires app.vopenworld.com to be proxied through Cloudflare (orange-cloud),
    with the origin (Vercel) reachable via a Worker route on
    `app.vopenworld.com/experiences/*`.
  - Swap resolvePost()/resolveCreator() to fetch from bff-api, e.g.
    `https://api.vopenworld.com/experiences/{slug}` and cache at the edge.
  - Keep the SEO field shape identical to src/.../seo.ts (SeoMeta) so the client
    and the edge stay in sync.
*/

const SITE_ORIGIN = "https://app.vopenworld.com";
const SITE_NAME = "vOpenWorld";
const TWITTER_SITE = "@vopenworld";
const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/og-default.jpg`;

/* Crawlers that need server-side meta (lowercased substrings of User-Agent). */
const CRAWLER_UA = [
  "facebookexternalhit",
  "facebot",
  "twitterbot",
  "slackbot",
  "linkedinbot",
  "discordbot",
  "telegrambot",
  "whatsapp",
  "pinterest",
  "redditbot",
  "googlebot",
  "bingbot",
  "applebot",
  "yandex",
  "zalo",
  "embedly",
  "skypeuripreview",
];

/* ── MOCK DATA — replace with a bff-api fetch when the backend is ready ──
   Shape mirrors ExperiencePost / Creator (only the SEO-relevant fields). */
const MOCK_POSTS = {
  "3-ngay-o-da-lat": {
    slug: "3-ngay-o-da-lat",
    title: { en: "3 days in Da Lat", vi: "3 ngày ở Đà Lạt" },
    excerpt: {
      en: "A relaxed 3-day itinerary through Da Lat's pine hills, cafés and night market.",
      vi: "Lịch trình 3 ngày thong thả qua đồi thông, quán cà phê và chợ đêm Đà Lạt.",
    },
    coverUrl:
      "https://images.unsplash.com/photo-1528127269322-539801943592?w=1200&q=80&auto=format&fit=crop",
    location: { en: "Da Lat, Vietnam", vi: "Đà Lạt, Việt Nam" },
    publishedAt: "2026-05-28",
    tags: [{ en: "Itinerary", vi: "Lịch trình" }],
    author: { id: "linh-tran", name: "Linh Trần" },
  },
};

const MOCK_CREATORS = {
  "linh-tran": {
    id: "linh-tran",
    name: "Linh Trần",
    handle: "linhtran",
    avatarUrl: "https://i.pravatar.cc/240?u=linh-tran",
    role: { en: "Travel writer", vi: "Cây viết du lịch" },
    bio: {
      en: "Sharing slow-travel itineraries across Vietnam.",
      vi: "Chia sẻ lịch trình du lịch chậm khắp Việt Nam.",
    },
    socials: [],
  },
};

/* In production these become async fetches to bff-api. */
function resolvePost(slug) {
  return MOCK_POSTS[slug] || null;
}
function resolveCreator(id) {
  return MOCK_CREATORS[id] || null;
}

/* ── tiny helpers (ported from seo.ts) ── */
const tx = (v, locale) => (v ? (locale === "vi" ? v.vi : v.en) : "");
const clamp = (s, max = 160) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const jsonLdSafe = (obj) => JSON.stringify(obj).replace(/</g, "\\u003c");
const experienceUrl = (slug) => `${SITE_ORIGIN}/experiences/${encodeURIComponent(slug)}`;
const creatorUrl = (id) => `${SITE_ORIGIN}/experiences/creator/${encodeURIComponent(id)}`;
const ogLocale = (l) => (l === "vi" ? "vi_VN" : "en_US");

/* Build the SeoMeta-equivalent for an article (mirrors buildArticleSeo). */
function articleMeta(post, locale) {
  const title = tx(post.title, locale);
  const description = clamp(tx(post.excerpt, locale));
  const canonical = experienceUrl(post.slug);
  const image = post.coverUrl || DEFAULT_OG_IMAGE;
  const tags = (post.tags || []).map((t) => tx(t, locale)).filter(Boolean);
  return {
    title: `${title} · ${SITE_NAME}`,
    description,
    canonical,
    image,
    imageAlt: title,
    type: "article",
    ogLocale: ogLocale(locale),
    publishedTime: post.publishedAt,
    authorName: post.author && post.author.name,
    section: tx(post.location, locale),
    tags,
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "Article",
        headline: clamp(title, 110),
        description,
        image: [image],
        url: canonical,
        datePublished: post.publishedAt,
        inLanguage: locale === "vi" ? "vi-VN" : "en-US",
        author: post.author
          ? { "@type": "Person", name: post.author.name, url: creatorUrl(post.author.id) }
          : undefined,
        publisher: { "@type": "Organization", name: SITE_NAME },
      },
    ],
  };
}

/* Build the SeoMeta-equivalent for a creator (mirrors buildCreatorSeo). */
function creatorMeta(creator, locale) {
  const role = tx(creator.role, locale);
  const bio = tx(creator.bio, locale);
  const title = `${creator.name}${role ? ` — ${role}` : ""}`;
  const description = clamp(bio || `${creator.name} (@${creator.handle}) on ${SITE_NAME}.`);
  const canonical = creatorUrl(creator.id);
  const image = creator.avatarUrl || DEFAULT_OG_IMAGE;
  return {
    title: `${title} · ${SITE_NAME}`,
    description,
    canonical,
    image,
    imageAlt: creator.name,
    type: "profile",
    ogLocale: ogLocale(locale),
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "ProfilePage",
        mainEntity: {
          "@type": "Person",
          name: creator.name,
          alternateName: `@${creator.handle}`,
          description: bio || undefined,
          image,
          url: canonical,
          jobTitle: role || undefined,
          sameAs: (creator.socials || []).map((s) => s.url).filter(Boolean),
        },
      },
    ],
  };
}

/* Serialise SeoMeta → an HTML <head> fragment. */
function metaToHtml(m) {
  const tags = [
    `<title>${esc(m.title)}</title>`,
    `<meta name="description" content="${esc(m.description)}">`,
    `<link rel="canonical" href="${esc(m.canonical)}">`,
    `<meta property="og:title" content="${esc(m.title)}">`,
    `<meta property="og:description" content="${esc(m.description)}">`,
    `<meta property="og:url" content="${esc(m.canonical)}">`,
    `<meta property="og:type" content="${esc(m.type)}">`,
    `<meta property="og:image" content="${esc(m.image)}">`,
    `<meta property="og:image:alt" content="${esc(m.imageAlt)}">`,
    `<meta property="og:site_name" content="${esc(SITE_NAME)}">`,
    `<meta property="og:locale" content="${esc(m.ogLocale)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(m.title)}">`,
    `<meta name="twitter:description" content="${esc(m.description)}">`,
    `<meta name="twitter:image" content="${esc(m.image)}">`,
    `<meta name="twitter:site" content="${esc(TWITTER_SITE)}">`,
  ];
  if (m.type === "article") {
    if (m.publishedTime)
      tags.push(`<meta property="article:published_time" content="${esc(m.publishedTime)}">`);
    if (m.authorName) tags.push(`<meta property="article:author" content="${esc(m.authorName)}">`);
    if (m.section) tags.push(`<meta property="article:section" content="${esc(m.section)}">`);
    (m.tags || []).forEach((t) => tags.push(`<meta property="article:tag" content="${esc(t)}">`));
  }
  const ld = m.jsonLd.length === 1 ? m.jsonLd[0] : m.jsonLd;
  tags.push(`<script type="application/ld+json">${jsonLdSafe(ld)}</script>`);
  return tags.join("\n");
}

function isCrawler(ua) {
  const u = (ua || "").toLowerCase();
  return CRAWLER_UA.some((bot) => u.includes(bot));
}

/* Choose locale from ?lang, Accept-Language, default vi (primary audience). */
function pickLocale(url, request) {
  const q = url.searchParams.get("lang");
  if (q === "vi" || q === "en") return q;
  const al = (request.headers.get("accept-language") || "").toLowerCase();
  if (al.startsWith("en")) return "en";
  return "vi";
}

/* Resolve SeoMeta for a path, or null if it isn't a prerenderable route. */
function metaForPath(pathname, locale) {
  const m = pathname.match(/^\/experiences\/creator\/([^/]+)\/?$/);
  if (m) {
    const c = resolveCreator(decodeURIComponent(m[1]));
    return c ? creatorMeta(c, locale) : null;
  }
  const a = pathname.match(/^\/experiences\/([^/]+)\/?$/);
  if (a && a[1] !== "new" && a[1] !== "me" && a[1] !== "network" && a[1] !== "notifications") {
    const p = resolvePost(decodeURIComponent(a[1]));
    return p ? articleMeta(p, locale) : null;
  }
  return null;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Only intervene for crawlers on experiences detail/creator routes.
    if (!isCrawler(request.headers.get("user-agent")) || !url.pathname.startsWith("/experiences/")) {
      return fetch(request);
    }

    const locale = pickLocale(url, request);
    const meta = metaForPath(url.pathname, locale);
    if (!meta) return fetch(request);

    // Fetch the real shell from origin and rewrite its <head>.
    const originResp = await fetch(request);
    const contentType = originResp.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return originResp;

    const headHtml = metaToHtml(meta);

    // HTMLRewriter (Cloudflare runtime) — strip the shell's generic title and
    // inject our SEO fragment at the start of <head>.
    return new HTMLRewriter()
      .on("title", { element: (el) => el.remove() })
      .on("head", {
        element: (el) => {
          el.prepend(headHtml, { html: true });
        },
      })
      .transform(originResp);
  },
};
