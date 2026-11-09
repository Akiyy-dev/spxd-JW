export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Duty = {id:string;weekday:Weekday;area:string;names:string[]};
export type DutiesData = {duties:Duty[];version:number};

export const WEEKDAYS:readonly {value:Weekday;label:string}[] = [
  {value:1,label:'周一'}, {value:2,label:'周二'}, {value:3,label:'周三'},
  {value:4,label:'周四'}, {value:5,label:'周五'}, {value:6,label:'周六'}, {value:7,label:'周日'},
];

export const DUTY_LIMITS = {rows:1000,id:100,area:100,names:100,name:100} as const;
