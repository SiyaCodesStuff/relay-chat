import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthUser, LoginRequest, RegisterRequest } from "@relay-chat/shared";
import { ApiError, authApi } from "../lib/api.js";

const authKey = ["auth", "me"] as const;
type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  login: (input: LoginRequest) => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  logout: () => Promise<void>;
};
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: authKey,
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return (await authApi.me(signal)).user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
  });
  async function setSession(user: AuthUser | null) {
    await queryClient.cancelQueries();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" });
    queryClient.setQueryData(authKey, user);
  }
  return (
    <AuthContext.Provider
      value={{
        user: session.data ?? null,
        loading: session.isPending,
        error: session.error,
        refresh: () => {
          void session.refetch();
        },
        login: async (input) => {
          await setSession((await authApi.login(input)).user);
        },
        register: async (input) => {
          await setSession((await authApi.register(input)).user);
        },
        logout: async () => {
          await authApi.logout();
          await setSession(null);
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider is required.");
  return value;
}
