import { useMemo, useState } from "react";
import { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableNull, TableRow, TableVirtualBody } from "@/components/table/table";

/** The smallest useful Table: a header and two rows. */
export function TableMinimal() {
  return (
    <Table aria-label="Connections" className="max-w-panel-md">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Host</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>orders-prod</TableCell>
          <TableCell>db.internal:5432</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>analytics</TableCell>
          <TableCell>wh.internal:5432</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  position: number;
}

const columns: Column[] = [
  { name: "id", type: "bigint", nullable: false, default: "nextval('orders_id_seq')", position: 1 },
  { name: "customer_id", type: "bigint", nullable: false, default: null, position: 2 },
  { name: "status", type: "text", nullable: false, default: "'open'", position: 3 },
  { name: "total", type: "numeric(12,2)", nullable: true, default: null, position: 4 },
  { name: "shipping_address_line_2_for_international_orders", type: "text", nullable: true, default: "''", position: 5 },
  { name: "created_at", type: "timestamptz", nullable: false, default: "now()", position: 6 },
];

/** A table's columns (sortable, striped, a NULL, a selected row, a long name, a footer), then 100,000 query rows virtualized. */
export function TableRealistic() {
  const [sort, setSort] = useState<{ key: keyof Column; dir: "ascending" | "descending" }>({ key: "position", dir: "ascending" });
  const sorted = useMemo(() => {
    const rows = [...columns].sort((a, b) => String(a[sort.key] ?? "").localeCompare(String(b[sort.key] ?? ""), "en", { numeric: true }));
    return sort.dir === "ascending" ? rows : rows.reverse();
  }, [sort]);
  const by = (key: keyof Column) => () => setSort((s) => ({ key, dir: s.key === key && s.dir === "ascending" ? "descending" : "ascending" }));
  const sortOf = (key: keyof Column) => (sort.key === key ? sort.dir : "none");

  return (
    <div className="flex w-full min-w-0 max-w-panel-xl flex-col gap-stack-lg">
      <Table variant="striped" aria-labelledby="orders-columns-caption">
        <TableCaption id="orders-columns-caption">6 columns of public.orders</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead align="end" sort={sortOf("position")} onSort={by("position")}>
              #
            </TableHead>
            <TableHead sort={sortOf("name")} onSort={by("name")}>
              Column
            </TableHead>
            <TableHead>Type</TableHead>
            <TableHead align="center">Nullable</TableHead>
            <TableHead>Default</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((column) => (
            <TableRow key={column.name} selected={column.name === "status"}>
              <TableCell align="end">{column.position}</TableCell>
              <TableCell title={column.name}>{column.name}</TableCell>
              <TableCell className="font-mono text-code">{column.type}</TableCell>
              <TableCell align="center">{column.nullable ? "yes" : "no"}</TableCell>
              <TableCell className="font-mono text-code">{column.default ?? <TableNull />}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={5}>Primary key: id</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
      <Table variant="bordered" aria-label="Query result, 100,000 rows" className="h-panel-md">
        <TableHeader>
          <TableRow>
            <TableHead align="end">id</TableHead>
            <TableHead>status</TableHead>
            <TableHead align="end">total</TableHead>
            <TableHead>note</TableHead>
          </TableRow>
        </TableHeader>
        <TableVirtualBody
          count={100_000}
          renderRow={(i) => (
            <TableRow key={i}>
              <TableCell align="end">{i + 1}</TableCell>
              <TableCell>{["open", "paid", "shipped"][i % 3]}</TableCell>
              <TableCell align="end">{((i * 7919) % 100_000) / 100}</TableCell>
              <TableCell>{i % 5 === 0 ? <TableNull /> : `order ${i + 1}`}</TableCell>
            </TableRow>
          )}
        />
      </Table>
    </div>
  );
}
