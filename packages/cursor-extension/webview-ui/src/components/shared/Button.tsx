import React from 'react';
import styles from './Button.module.css';

type ButtonVariant = 'primary' | 'secondary' | 'danger';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  children: React.ReactNode;
}

export default function Button({ 
  variant = 'primary', 
  className,
  children, 
  ...props 
}: Props) {
  const variantClass = {
    primary: styles.primary,
    secondary: styles.secondary,
    danger: styles.danger,
  }[variant];

  return (
    <button 
      className={`${styles.button} ${variantClass} ${className || ''}`}
      {...props}
    >
      {children}
    </button>
  );
}
