import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { supabase } from '../../shared/supabase';
interface AuthValue { session: Session | null; loading: boolean; signOut: () => Promise<void>; }
const AuthContext = createContext<AuthValue | null>(null);
export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); setLoading(false); });
    const appState = AppState.addEventListener('change', state => state === 'active' ? supabase.auth.startAutoRefresh() : supabase.auth.stopAutoRefresh());
    return () => { data.subscription.unsubscribe(); appState.remove(); };
  }, []);
  const value = useMemo<AuthValue>(() => ({ session, loading, signOut: async () => {
    const userId = session?.user.id;
    if (userId) {
      const keys = await AsyncStorage.getAllKeys();
      const owned = keys.filter(key => key === `tenant-selection:v1:${userId}` || key.startsWith(`offline:operations:v3:${userId}:`));
      if (owned.length) await AsyncStorage.multiRemove(owned);
    }
    const { error } = await supabase.auth.signOut(); if (error) throw error;
  } }), [loading, session]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth(): AuthValue { const value = useContext(AuthContext); if (!value) throw new Error('useAuth must be used inside AuthProvider.'); return value; }
