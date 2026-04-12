import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { auth0 } from "./lib/auth0";

function normalizedPathname(request: NextRequest): string {
  let { pathname } = request.nextUrl;
  const basePath = request.nextUrl.basePath;
  if (basePath && pathname.startsWith(basePath)) {
    pathname = pathname.slice(basePath.length) || "/";
  }
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  return pathname;
}

export async function proxy(request: NextRequest) {
  const pathname = normalizedPathname(request);
  const sdkResponse = await auth0.middleware(request);

  // Public marketing / landing only
  if (pathname === "/") {
    return sdkResponse;
  }

  // Auth0 SDK routes (login, callback, logout, profile, etc.)
  if (pathname.startsWith("/auth")) {
    return sdkResponse;
  }

  const session = await auth0.getSession(request);
  if (!session) {
    const login = new URL("/auth/login", request.url);
    login.searchParams.set(
      "returnTo",
      `${pathname}${request.nextUrl.search}`,
    );
    return NextResponse.redirect(login);
  }

  return sdkResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
