import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export interface AuthConfig {
    apiEndpoint: string;
}

interface AuthUser {
    email: string;
    sub: string;
}

interface AuthContextType {
    user: AuthUser | null;
    idToken: string | null;
    isLoading: boolean;
    signOut: () => void;
    config: AuthConfig;
}

export const AuthContext = createContext<AuthContextType | null>(null);

const SSO_TOKEN_COOKIE = 'sso_token_readable';

function getCookie(name: string): string | null {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

function decodeJwtPayload(token: string): any {
    const payload = token.split('.')[1];
    let base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    return JSON.parse(decodeURIComponent(escape(atob(base64))));
}

function isTokenExpired(token: string): boolean {
    try {
        const payload = decodeJwtPayload(token);
        return Date.now() >= payload.exp * 1000;
    } catch {
        return true;
    }
}

export function AuthProvider({ children, config }: { children: React.ReactNode; config: AuthConfig }) {
    const [user, setUser] = useState<AuthUser | null>(null);
    const [idToken, setIdToken] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        // Lambda@Edge sets sso_token as a non-HttpOnly cookie (sso_token_readable)
        // so the frontend can read it for API calls
        const token = getCookie(SSO_TOKEN_COOKIE);
        if (token && !isTokenExpired(token)) {
            try {
                const payload = decodeJwtPayload(token);
                setUser({ email: payload.email, sub: payload.sub });
                setIdToken(token);
            } catch {
                // invalid token, Lambda@Edge will handle re-auth on next navigation
            }
        }
        // If no valid token, Lambda@Edge will redirect to SSO Portal
        // before the page even loads, so this state is only reached
        // if the token just expired mid-session
        setIsLoading(false);
    }, []);

    const signOut = useCallback(() => {
        // Clear both cookies and reload — Lambda@Edge will redirect to SSO
        document.cookie = `sso_token_readable=; Path=/; Max-Age=0; Secure; SameSite=Lax`;
        document.cookie = `sso_token=; Path=/; Max-Age=0; Secure; SameSite=Lax`;
        window.location.reload();
    }, []);

    return (
        <AuthContext.Provider value={{ user, idToken, isLoading, signOut, config }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth(): AuthContextType {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
}
