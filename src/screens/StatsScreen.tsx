import React, { useCallback, useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { colors } from '../lib/theme';
import { getThrows, clearAllThrows, deleteThrow, ThrowRecord } from '../lib/db';

export default function StatsScreen() {
  const [throws, setThrows] = useState<ThrowRecord[]>([]);

  const load = useCallback(() => {
    setThrows(getThrows());
  }, []);

  useFocusEffect(load);

  const handleClearAll = () => {
    Alert.alert('Clear All Stats', 'Delete all recorded throws?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete All',
        style: 'destructive',
        onPress: () => {
          clearAllThrows();
          setThrows([]);
        },
      },
    ]);
  };

  const handleDelete = (id: number) => {
    deleteThrow(id);
    setThrows((prev) => prev.filter((t) => t.id !== id));
  };

  const avgSpeed =
    throws.length > 0
      ? (throws.reduce((s, t) => s + t.speed_mph, 0) / throws.length).toFixed(1)
      : '--';
  const maxSpeed =
    throws.length > 0
      ? Math.max(...throws.map((t) => t.speed_mph)).toFixed(1)
      : '--';
  const avgSpin =
    throws.length > 0
      ? Math.round(throws.reduce((s, t) => s + t.spin_rpm, 0) / throws.length)
      : '--';

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        STATS<Text style={{ color: colors.cyan }}> LOG</Text>
      </Text>

      {/* Summary cards */}
      <View style={styles.summaryRow}>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>AVG SPEED</Text>
          <Text style={styles.cardValue}>{avgSpeed}</Text>
          <Text style={styles.cardUnit}>mph</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>TOP SPEED</Text>
          <Text style={styles.cardValue}>{maxSpeed}</Text>
          <Text style={styles.cardUnit}>mph</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>AVG SPIN</Text>
          <Text style={styles.cardValue}>{avgSpin}</Text>
          <Text style={styles.cardUnit}>rpm</Text>
        </View>
      </View>

      {/* Header row */}
      <View style={styles.tableHeader}>
        <Text style={[styles.col, styles.colDate]}>#</Text>
        <Text style={[styles.col, styles.colDate]}>DATE</Text>
        <Text style={[styles.col, styles.colStat]}>MPH</Text>
        <Text style={[styles.col, styles.colStat]}>RPM</Text>
        <Text style={styles.colDel} />
      </View>

      {throws.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No throws recorded yet.</Text>
          <Text style={styles.emptySubText}>
            Go to the Camera tab and make your first throw!
          </Text>
        </View>
      ) : (
        <FlatList
          data={throws}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item, index }) => (
            <View style={styles.row}>
              <Text style={[styles.col, styles.colDate, styles.rowIndex]}>
                {throws.length - index}
              </Text>
              <Text style={[styles.col, styles.colDate, styles.rowText]}>
                {formatDate(item.created_at)}
              </Text>
              <Text style={[styles.col, styles.colStat, styles.rowSpeed]}>
                {item.speed_mph.toFixed(1)}
              </Text>
              <Text style={[styles.col, styles.colStat, styles.rowSpin]}>
                {item.spin_rpm}
              </Text>
              <TouchableOpacity
                style={styles.colDel}
                onPress={() => handleDelete(item.id)}
              >
                <Text style={styles.delText}>✕</Text>
              </TouchableOpacity>
            </View>
          )}
          contentContainerStyle={{ paddingBottom: 32 }}
        />
      )}

      {throws.length > 0 && (
        <TouchableOpacity style={styles.clearBtn} onPress={handleClearAll}>
          <Text style={styles.clearBtnText}>Clear All</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, paddingTop: 56 },
  title: {
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 4,
    color: colors.white,
    textAlign: 'center',
    marginBottom: 20,
  },
  summaryRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 10,
    marginBottom: 24,
  },
  card: {
    flex: 1,
    backgroundColor: colors.bgCard,
    borderRadius: 14,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.grayDark,
  },
  cardLabel: { color: colors.gray, fontSize: 10, letterSpacing: 2, marginBottom: 4 },
  cardValue: { color: colors.cyanLight, fontSize: 28, fontWeight: '900' },
  cardUnit: { color: colors.cyan, fontSize: 11, letterSpacing: 1 },

  tableHeader: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.grayDark,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.grayDark + '60',
    alignItems: 'center',
  },
  col: { color: colors.gray, fontSize: 12 },
  colDate: { flex: 2 },
  colStat: { flex: 1, textAlign: 'right' },
  colDel: { width: 32, alignItems: 'center' },
  rowIndex: { color: colors.gray, fontSize: 11 },
  rowText: { color: colors.white, fontSize: 13 },
  rowSpeed: { color: colors.cyan, fontSize: 15, fontWeight: '700', textAlign: 'right' },
  rowSpin: { color: colors.cyanLight, fontSize: 14, fontWeight: '600', textAlign: 'right' },
  delText: { color: colors.red, fontSize: 14 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyText: { color: colors.white, fontSize: 18, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySubText: { color: colors.gray, fontSize: 14, textAlign: 'center', lineHeight: 20 },

  clearBtn: {
    margin: 16,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.red,
    alignItems: 'center',
  },
  clearBtnText: { color: colors.red, fontWeight: '700', letterSpacing: 2 },
});
