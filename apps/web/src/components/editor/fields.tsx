import { useId, type ReactNode } from "react"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

export function SliderField(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format?: (v: number) => string
  description?: string
  disabled?: boolean
  onChange: (v: number) => void
}) {
  const id = useId()
  return (
    <Field data-disabled={props.disabled || undefined}>
      <div className="flex items-center justify-between">
        <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {props.format ? props.format(props.value) : props.value}
        </span>
      </div>
      <Slider
        id={id}
        value={[props.value]}
        min={props.min}
        max={props.max}
        step={props.step}
        disabled={props.disabled}
        onValueChange={(v) => props.onChange(v[0])}
      />
      {props.description ? (
        <FieldDescription>{props.description}</FieldDescription>
      ) : null}
    </Field>
  )
}

export function SwitchField(props: {
  label: string
  description?: ReactNode
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <Field orientation="horizontal" data-disabled={props.disabled || undefined}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
        {props.description ? (
          <FieldDescription>{props.description}</FieldDescription>
        ) : null}
      </FieldContent>
      <Switch
        id={id}
        checked={props.checked}
        onCheckedChange={props.onChange}
        disabled={props.disabled}
      />
    </Field>
  )
}

export function ColorField(props: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const id = useId()
  // <input type=color> only supports #rrggbb; keep alpha suffix if present
  const hex = props.value.slice(0, 7)
  const alpha = props.value.length === 9 ? props.value.slice(7) : ""
  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">
          {props.value}
        </span>
        <input
          id={id}
          type="color"
          value={hex}
          onChange={(e) => props.onChange(e.target.value + alpha)}
          className="h-7 w-10 cursor-pointer border bg-transparent"
        />
      </div>
    </Field>
  )
}

export function SelectField<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  const id = useId()
  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <Select value={props.value} onValueChange={(v) => props.onChange(v as T)}>
        <SelectTrigger id={id} size="sm" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {props.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

export function ToggleField<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <Field>
      <FieldLabel>{props.label}</FieldLabel>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={props.value}
        onValueChange={(v) => v && props.onChange(v as T)}
        className="flex-wrap"
      >
        {props.options.map((o) => (
          <ToggleGroupItem key={o.value} value={o.value}>
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Field>
  )
}

export function TextField(props: {
  label: string
  value: string
  placeholder?: string
  onChange: (v: string) => void
}) {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <Input
        id={id}
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </Field>
  )
}
