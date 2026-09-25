// FIXTURE: auth gate — unauthenticated users land on /login
import { NextResponse } from "next/server";
export function middleware(req) {
  return NextResponse.redirect(new URL("/login", req.url));
}
