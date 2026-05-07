export type AuthMode = 'login' | 'signup';

export function pathForMode(mode: AuthMode): '/login' | '/signup' {
  return mode === 'signup' ? '/signup' : '/login';
}

export function modeForPath(pathname: string | null | undefined): AuthMode {
  return pathname === '/signup' ? 'signup' : 'login';
}
