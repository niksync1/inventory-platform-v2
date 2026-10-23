import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, spacing } from '../../shared/theme';
import { supabase } from '../../shared/supabase';
import { useTenant } from '../tenancy/TenantProvider';
import { listProducts, type ProductInventory } from './inventoryApi';

interface ListingRow { product_id: string; retail_price: number; currency: string; is_published: boolean; }
export function PublicCatalogueManagementScreen({ onBack }: { onBack: () => void }) {
  const { context } = useTenant();
  const [products, setProducts] = useState<ProductInventory[]>([]);
  const [listings, setListings] = useState<Map<string, ListingRow>>(new Map());
  const [selected, setSelected] = useState<ProductInventory | null>(null);
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('GHS');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!context) return;
    setLoading(true); setError(null);
    try {
      const [productRows, listingRows] = await Promise.all([
        listProducts(context.tenant.id, context.locationId),
        supabase.from('public_catalogue_listings').select('product_id,retail_price,currency,is_published').eq('tenant_id', context.tenant.id),
      ]);
      if (listingRows.error) throw listingRows.error;
      setProducts(productRows);
      const next = new Map<string, ListingRow>();
      for (const row of (listingRows.data ?? []) as ListingRow[]) next.set(row.product_id, row);
      setListings(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load catalogue settings.');
    } finally { setLoading(false); }
  }, [context]);

  useEffect(() => { void load(); }, [load]);

  function chooseProduct(product: ProductInventory) {
    const listing = listings.get(product.id);
    setSelected(product);
    setPrice(listing ? String(listing.retail_price) : '');
    setCurrency(listing?.currency ?? 'GHS');
    setMessage(null); setError(null);
  }

  async function save(publish: boolean) {
    if (!context || !selected) return;
    const amount = Number(price);
    if (!Number.isFinite(amount) || amount < 0 || price.trim() === '') { setError('Enter a valid non-negative retail price.'); return; }
    if (!/^[A-Z]{3}$/.test(currency.trim())) { setError('Currency must be a three-letter uppercase code, such as GHS.'); return; }
    setSaving(true); setError(null); setMessage(null);
    try {
      const { error: saveError } = await supabase.from('public_catalogue_listings').upsert({
        tenant_id: context.tenant.id,
        product_id: selected.id,
        retail_price: amount,
        currency: currency.trim(),
        is_published: publish,
      }, { onConflict: 'tenant_id,product_id' });
      if (saveError) throw saveError;
      setMessage(publish ? 'Product published to the public catalogue.' : 'Product unpublished from the public catalogue.');
      await load();
      const updated = listings.get(selected.id);
      setListings(current => {
        const next = new Map(current);
        next.set(selected.id, { product_id: selected.id, retail_price: amount, currency: currency.trim(), is_published: publish });
        return next;
      });
      if (!updated || updated.is_published !== publish) setSelected({ ...selected });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to save public listing.');
    } finally { setSaving(false); }
  }

  if (!context) return null;
  return <View style={styles.screen}>
    <View style={styles.header}><Pressable onPress={onBack}><Text style={styles.link}>‹ Home</Text></Pressable><Text style={styles.title}>Public catalogue</Text></View>
    <Text style={styles.subtitle}>Select a product, set one retail price for this business, then publish it. Supplier cost stays private.</Text>
    {loading ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {message ? <Text style={styles.message}>{message}</Text> : null}
    {selected ? <View style={styles.editor}>
      <Text style={styles.productName}>{selected.name}</Text>
      <Text style={styles.label}>Retail price</Text>
      <TextInput keyboardType="decimal-pad" placeholder="0.00" value={price} onChangeText={setPrice} style={styles.input} />
      <Text style={styles.label}>Currency code</Text>
      <TextInput autoCapitalize="characters" maxLength={3} value={currency} onChangeText={value => setCurrency(value.toUpperCase())} style={styles.input} />
      <View style={styles.actions}>
        <Pressable disabled={saving} onPress={() => void save(true)} style={[styles.button, saving && styles.disabled]}><Text style={styles.buttonText}>{saving ? 'Saving…' : 'Save & publish'}</Text></Pressable>
        <Pressable disabled={saving} onPress={() => void save(false)} style={styles.outline}><Text style={styles.outlineText}>Unpublish</Text></Pressable>
      </View>
      <Pressable onPress={() => setSelected(null)}><Text style={styles.link}>Choose another product</Text></Pressable>
    </View> : null}
    <FlatList data={products} keyExtractor={item => item.id} contentContainerStyle={styles.list} ListEmptyComponent={!loading ? <Text style={styles.empty}>No active products are available to publish.</Text> : null}
      renderItem={({ item }) => { const listing = listings.get(item.id); return <Pressable onPress={() => chooseProduct(item)} style={styles.row}><View style={styles.rowMain}><Text style={styles.productName}>{item.name}</Text><Text style={styles.meta}>{listing?.is_published ? 'Published' : listing ? 'Unpublished draft' : 'Not published'}</Text></View><Text style={styles.link}>{listing ? `${listing.currency} ${Number(listing.retail_price).toFixed(2)}` : 'Set price ›'}</Text></Pressable>; }} />
  </View>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  header: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  title: { color: colors.text, fontSize: 24, fontWeight: '700' },
  subtitle: { color: colors.textMuted, lineHeight: 20, marginTop: spacing.sm },
  link: { color: colors.primary, fontWeight: '700' },
  loader: { marginTop: spacing.lg },
  error: { color: '#B42318', marginTop: spacing.sm },
  message: { color: '#067647', marginTop: spacing.sm },
  editor: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 14, borderWidth: 1, marginTop: spacing.md, padding: spacing.md },
  productName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  label: { color: colors.text, fontWeight: '700', marginTop: spacing.sm },
  input: { backgroundColor: colors.background, borderColor: colors.border, borderRadius: 10, borderWidth: 1, marginTop: spacing.xs, padding: spacing.md },
  actions: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.md },
  button: { alignItems: 'center', backgroundColor: colors.primary, borderRadius: 10, flex: 1, justifyContent: 'center', padding: spacing.md },
  buttonText: { color: '#fff', fontWeight: '700' },
  outline: { alignItems: 'center', borderColor: colors.primary, borderRadius: 10, borderWidth: 1, justifyContent: 'center', padding: spacing.md },
  outlineText: { color: colors.primary, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  list: { paddingVertical: spacing.md },
  empty: { color: colors.textMuted, marginTop: spacing.lg },
  row: { alignItems: 'center', borderBottomColor: colors.border, borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingVertical: spacing.md },
  rowMain: { flex: 1, paddingRight: spacing.sm },
  meta: { color: colors.textMuted, fontSize: 12, marginTop: spacing.xs },
});
