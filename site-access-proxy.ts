import { next } from '@vercel/functions';
import siteAccess from './api/_site-access.js';

const handleSiteAccess = siteAccess.createSiteAccessHandler();

// Runs before static files, API rewrites and the CDN cache on every alias.
export default async function proxy(request: Request) {
  const deniedOrLogin = await handleSiteAccess(request);
  if (deniedOrLogin) return deniedOrLogin;
  const response = next();
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('CDN-Cache-Control', 'no-store');
  response.headers.set('Vercel-CDN-Cache-Control', 'no-store');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return response;
}
