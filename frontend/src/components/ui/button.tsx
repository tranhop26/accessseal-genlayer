"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from "react";
import styles from "./ui.module.css";

type ButtonStyle = "primary" | "secondary" | "ghost";

type SharedButtonProps = {
  children: ReactNode;
  variant?: ButtonStyle;
};

type LinkButtonProps = SharedButtonProps & {
  href: string;
  onClick?: never;
};

type ActionButtonProps = SharedButtonProps &
  Pick<ButtonHTMLAttributes<HTMLButtonElement>, "disabled" | "type"> & {
    href?: never;
    onClick: MouseEventHandler<HTMLButtonElement>;
  };

export type ButtonProps = LinkButtonProps | ActionButtonProps;

export function Button({ children, variant = "primary", ...props }: ButtonProps) {
  const className = `${styles.button} ${styles[`button${variant}`]}`;

  if (props.href !== undefined)
    return (
      <Link className={className} href={props.href}>
        {children}
      </Link>
    );

  return (
    <button className={className} disabled={props.disabled} onClick={props.onClick} type={props.type ?? "button"}>
      {children}
    </button>
  );
}
