import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError } from './api.ts';
import type { User } from '../../shared/types.ts';

interface AuthValue {
  user: User | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

async function fetchMe(): Promise<User | null> {
  try {
    const { user } = await api.get<{ user: User | null }>('/api/me');
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data: user, isLoading } = useQuery({ queryKey: ['me'], queryFn: fetchMe });

  const loginMut = useMutation({
    mutationFn: (vars: { username: string; password: string }) =>
      api.post<{ user: User }>('/api/auth/login', vars),
    onSuccess: ({ user }) => qc.setQueryData(['me'], user),
  });

  const logoutMut = useMutation({
    mutationFn: () => api.post('/api/auth/logout'),
    onSuccess: () => {
      qc.setQueryData(['me'], null);
      qc.clear();
    },
  });

  const value: AuthValue = {
    user: user ?? null,
    isLoading,
    login: async (username, password) => {
      await loginMut.mutateAsync({ username, password });
    },
    logout: async () => {
      await logoutMut.mutateAsync();
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <div className="spinner" />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}
