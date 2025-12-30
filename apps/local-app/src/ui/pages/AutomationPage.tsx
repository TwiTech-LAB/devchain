import { useState } from 'react';
import { Eye, Bell } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/components/ui/tabs';
import { WatchersTab } from '@/ui/components/automation/WatchersTab';
import { SubscribersTab } from '@/ui/components/automation/SubscribersTab';

type TabValue = 'watchers' | 'subscribers';

export function AutomationPage() {
  const [activeTab, setActiveTab] = useState<TabValue>('watchers');

  return (
    <div className="container py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Automation</h1>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabValue)}>
        <TabsList>
          <TabsTrigger value="watchers">
            <Eye className="w-4 h-4 mr-2" />
            Watchers
          </TabsTrigger>
          <TabsTrigger value="subscribers">
            <Bell className="w-4 h-4 mr-2" />
            Subscribers
          </TabsTrigger>
        </TabsList>

        <TabsContent value="watchers">
          <WatchersTab />
        </TabsContent>
        <TabsContent value="subscribers">
          <SubscribersTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
