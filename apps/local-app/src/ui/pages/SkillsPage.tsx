import { useEffect, useState } from 'react';
import { BarChart3, Sparkles } from 'lucide-react';
import { SkillDetailDrawer } from '@/ui/components/skills/SkillDetailDrawer';
import { SkillsListTab } from '@/ui/components/skills/SkillsListTab';
import { SkillsStatsTab } from '@/ui/components/skills/SkillsStatsTab';
import { SourcesPopover } from '@/ui/components/skills/SourcesPopover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/components/ui/tabs';

type SkillsTabValue = 'skills' | 'stats';

export function SkillsPage() {
  const [activeTab, setActiveTab] = useState<SkillsTabValue>('skills');
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab !== 'skills') {
      setSelectedSkillId(null);
    }
  }, [activeTab]);

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Skills</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Browse skills, enable or disable them per project, and inspect usage trends.
          </p>
        </div>
        <SourcesPopover />
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as SkillsTabValue)}
        className="space-y-4"
      >
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="skills" className="gap-2">
            <Sparkles className="h-4 w-4" />
            Skills
          </TabsTrigger>
          <TabsTrigger value="stats" className="gap-2">
            <BarChart3 className="h-4 w-4" />
            Stats
          </TabsTrigger>
        </TabsList>

        <TabsContent value="skills" className="space-y-4">
          <SkillsListTab onSelectSkill={setSelectedSkillId} />
        </TabsContent>

        <TabsContent value="stats">
          <SkillsStatsTab />
        </TabsContent>
      </Tabs>

      <SkillDetailDrawer skillId={selectedSkillId} onClose={() => setSelectedSkillId(null)} />
    </div>
  );
}
