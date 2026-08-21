import type { Key, ReactNode } from "react";
import styles from "./ui.module.css";

export type DataTableColumn<Row> = {
  key: keyof Row;
  label: string;
  render?: (row: Row) => ReactNode;
};

export function DataTable<Row extends Record<string, ReactNode>>({
  columns,
  rows,
  getRowKey = (_, index) => index,
}: {
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowKey?: (row: Row, index: number) => Key;
}) {
  return (
    <div className={styles.tableScroll}>
      <table className={styles.dataTable}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={String(column.key)} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={getRowKey(row, index)}>
              {columns.map((column) => (
                <td key={String(column.key)}>
                  {column.render?.(row) ?? row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MobileDataRow({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <dl className={styles.mobileDataRow}>
      <div>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    </dl>
  );
}
