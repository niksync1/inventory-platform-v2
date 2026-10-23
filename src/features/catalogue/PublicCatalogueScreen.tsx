import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, spacing } from '../../shared/theme';
import { supabase } from '../../shared/supabase';

interface PublicProduct {
  listing_id: string;
  business_name: string;
  product_name: string;
  description: string;
  images: string[] | null;
  retail_price: number;
  currency: string;
  available: boolean;
}

export function PublicCatalogueScreen({ onCreateBusiness, onSignOut }: { onCreateBusiness: () => void; onSignOut: () => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<PublicProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const load = useCallback(async (term = query) => {
    setError(null);
    try {
      const result = await supabase.rpc('search_public_catalogue', { p_query: term.trim() || null });
      if (result.error) throw result.error;
      setProducts((result.data ?? []) as PublicProduct[]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load the public catalogue.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(() => void load(query), 250);
    return () => clearTimeout(timer);
  }, [load, query]);

  async function signOut() {
    setSigningOut(true);
    try { await onSignOut(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to sign out.'); setSigningOut(false); }
  }

  return <View style={styles.screen}>
    <View style={styles.header}>
      <View style={styles.headerText}>
        <Text style={styles.eyebrow}>PUBLIC CATALOGUE</Text>
        <Text style={styles.title}>Discover products</Text>
      </View>
      <Pressable onPress={() => void signOut()} disabled={signingOut}>
        <Text style={styles.link}>{signingOut ? 'Signing out…' : 'Sign out'}</Text>
      </Pressable>
    </View>
    <Text style={styles.subtitle}>Search products published by participating businesses.</Text>
    <TextInput
      accessibilityLabel="Search public products"
      autoCapitalize="none"
      placeholder="Search product name or description"
      returnKeyType="search"
      value={query}
      onChangeText={setQuery}
      style={styles.search}
    />
    <View style={styles.secondaryActions}>
      <Text style={styles.hint}>Picture search is planned as a separate image-matching service.</Text>
      <Pressable onPress={onCreateBusiness}><Text style={styles.link}>Create a business</Text></Pressable>
    </View>
    {loading && !refreshing ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
    {error ? <Text style={styles.error}>{error}</Text> : null}
    <FlatList
      data={products}
      keyExtractor={item => item.listing_id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
      contentContainerStyle={products.length ? styles.list : styles.emptyList}
      ListEmptyComponent={!loading ? <Text style={styles.empty}>{query.trim() ? 'No published products match your search.' : 'No products have been published yet.'}</Text> : null}
      renderItem={({ item }) => {
        const imageUri = item.images?.find(value => /^https?:\/\//i.test(value));
        let price = `${item.currency} ${Number(item.retail_price).toFixed(2)}`;
        try { price = new Intl.NumberFormat(undefined, { style: 'currency', currency: item.currency }).format(Number(item.retail_price)); } catch { /* use the currency-code fallback */ }
        return <View style={styles.card}>
          {imageUri ? <Image source={{ uri: imageUri }} resizeMode="cover" style={styles.image} /> : <View style={[styles.image, styles.imagePlaceholder]}><Text style={styles.placeholderText}>No image</Text></View>}
          <View style={styles.cardBody}>
            <Text style={styles.productName}>{item.product_name}</Text>
            <Text style={styles.business}>{item.business_name}</Text>
            <Text style={styles.price}>{price}</Text>
            <Text style={[styles.availability, item.available ? styles.available : styles.unavailable]}>{item.available ? 'Available' : 'Unavailable'}</Text>
            {item.description ? <Text style={styles.description}>{item.description}</Text> : null}
          </View>
        </View>;
      }}
    />
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  headerText: { flex: 1 },
  eyebrow: { color: colors.primary, fontSize: 11, fontWeight: '700', letterSpacing: 1.4 },
  title: { color: colors.text, fontSize: 28, fontWeight: '700', marginTop: spacing.xs },
  subtitle: { color: colors.textMuted, lineHeight: 20, marginTop: spacing.sm },
  search: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, fontSize: 16, marginTop: spacing.md, padding: spacing.md },
  secondaryActions: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, marginTop: spacing.sm },
  hint: { color: colors.textMuted, flex: 1, fontSize: 11 },
  link: { color: colors.primary, fontWeight: '700' },
  loader: { marginTop: spacing.lg },
  error: { color: '#B42318', marginTop: spacing.md },
  list: { paddingBottom: spacing.xl, paddingTop: spacing.md },
  emptyList: { flexGrow: 1, justifyContent: 'center', paddingBottom: spacing.xl, paddingTop: spacing.md },
  empty: { color: colors.textMuted, textAlign: 'center' },
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 16, borderWidth: 1, marginBottom: spacing.md, overflow: 'hidden' },
  image: { backgroundColor: '#E8EDF0', height: 180, width: '100%' },
  imagePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  placeholderText: { color: colors.textMuted },
  cardBody: { padding: spacing.md },
  productName: { color: colors.text, fontSize: 18, fontWeight: '700' },
  business: { color: colors.textMuted, fontSize: 12, marginTop: spacing.xs },
  price: { color: colors.primary, fontSize: 20, fontWeight: '700', marginTop: spacing.sm },
  availability: { alignSelf: 'flex-start', borderRadius: 8, fontSize: 12, fontWeight: '700', marginTop: spacing.sm, overflow: 'hidden', paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  available: { backgroundColor: '#E6F4EF', color: '#176B5B' },
  unavailable: { backgroundColor: '#FDECEC', color: '#B42318' },
  description: { color: colors.textMuted, lineHeight: 20, marginTop: spacing.sm },
});
