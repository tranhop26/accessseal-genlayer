import styles from "./ui.module.css";

export function Timeline({
  label,
  items,
  current,
}: {
  label: string;
  items: readonly string[];
  current: string;
}) {
  const currentIndex = items.indexOf(current);

  return (
    <ol aria-label={label} className={styles.timeline} tabIndex={0}>
      {items.map((item, index) => (
        <li
          key={item}
          aria-current={item === current ? "step" : undefined}
          data-state={
            index < currentIndex
              ? "complete"
              : item === current
                ? "current"
                : "upcoming"
          }
        >
          <span aria-hidden="true" />
          {item.replaceAll("_", " ")}
        </li>
      ))}
    </ol>
  );
}
