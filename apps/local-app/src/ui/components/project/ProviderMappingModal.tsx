import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { AlertTriangle, XCircle } from 'lucide-react';

/**
 * Represents a family of profiles and their provider alternatives.
 */
export interface FamilyAlternative {
  /** The family slug (e.g., 'coder', 'reviewer') */
  familySlug: string;
  /** The default provider name from the template */
  defaultProvider: string;
  /** Whether the default provider is available locally */
  defaultProviderAvailable: boolean;
  /** Provider names that have profiles for this family and are available locally */
  availableProviders: string[];
  /** Whether there are alternative providers available */
  hasAlternatives: boolean;
}

interface ProviderMappingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  missingProviders: string[];
  familyAlternatives: FamilyAlternative[];
  canImport: boolean;
  onConfirm: (mappings: Record<string, string>) => void;
  loading?: boolean;
}

/**
 * Modal displayed when provider mapping is required during template import/create.
 * Allows users to select alternative providers for families with missing defaults.
 */
export function ProviderMappingModal({
  open,
  onOpenChange,
  missingProviders,
  familyAlternatives,
  canImport,
  onConfirm,
  loading = false,
}: ProviderMappingModalProps) {
  // Track selected provider for each family
  const [mappings, setMappings] = useState<Record<string, string>>({});

  // Initialize mappings with first available provider for families that need mapping
  useEffect(() => {
    if (open) {
      const initialMappings: Record<string, string> = {};
      for (const family of familyAlternatives) {
        if (!family.defaultProviderAvailable && family.hasAlternatives) {
          // Default to first available provider
          initialMappings[family.familySlug] = family.availableProviders[0];
        }
      }
      setMappings(initialMappings);
    }
  }, [open, familyAlternatives]);

  const handleProviderChange = (familySlug: string, provider: string) => {
    setMappings((prev) => ({
      ...prev,
      [familySlug]: provider,
    }));
  };

  const handleConfirm = () => {
    onConfirm(mappings);
  };

  // Filter to only show families that need mapping (default not available)
  const familiesNeedingMapping = familyAlternatives.filter(
    (family) => !family.defaultProviderAvailable,
  );

  // Check if all required mappings have a selection
  const allMappingsSelected = familiesNeedingMapping
    .filter((f) => f.hasAlternatives)
    .every((f) => mappings[f.familySlug]);

  // Families with no alternatives (used for "Cannot Import" messaging)
  const familiesWithNoAlternatives = familiesNeedingMapping.filter((f) => !f.hasAlternatives);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
            </div>
            <DialogTitle>Provider Configuration Required</DialogTitle>
          </div>
          <DialogDescription className="text-left">
            The recommended provider configuration is not possible because some providers are
            missing. You can map to different providers, but this may lead to unexpected behavior.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Missing providers alert */}
          <Alert variant="default" className="border-amber-500/50 bg-amber-500/10">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <AlertTitle className="text-amber-600 dark:text-amber-400">
              Missing Providers
            </AlertTitle>
            <AlertDescription className="text-amber-600 dark:text-amber-400">
              {missingProviders.join(', ')}
            </AlertDescription>
          </Alert>

          {/* Family mapping table */}
          {familiesNeedingMapping.length > 0 && (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Family</TableHead>
                    <TableHead>Default Provider</TableHead>
                    <TableHead>Use Instead</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {familiesNeedingMapping.map((family) => (
                    <TableRow key={family.familySlug}>
                      <TableCell className="font-medium">{family.familySlug}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2 text-destructive">
                          {family.defaultProvider}
                          <XCircle className="h-4 w-4" />
                        </span>
                      </TableCell>
                      <TableCell>
                        {family.hasAlternatives ? (
                          <Select
                            value={mappings[family.familySlug] || ''}
                            onValueChange={(value) =>
                              handleProviderChange(family.familySlug, value)
                            }
                          >
                            <SelectTrigger className="w-[180px]">
                              <SelectValue placeholder="Select provider" />
                            </SelectTrigger>
                            <SelectContent>
                              {family.availableProviders.map((provider) => (
                                <SelectItem key={provider} value={provider}>
                                  {provider}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="h-4 w-4" />
                            No alternatives
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Cannot import - canImport is false */}
          {!canImport && (
            <Alert variant="destructive">
              <XCircle className="h-4 w-4" />
              <AlertTitle>Cannot Import</AlertTitle>
              <AlertDescription>
                One or more required families have no available providers:{' '}
                {familiesWithNoAlternatives.map((f) => f.familySlug).join(', ')}. Install the
                missing providers ({missingProviders.join(', ')}) first.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          {canImport && (
            <Button onClick={handleConfirm} disabled={loading || !allMappingsSelected}>
              {loading ? 'Importing...' : 'Import'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
