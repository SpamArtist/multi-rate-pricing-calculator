export type SummaryReportProps = {
  userId: string;
  reportOpen: boolean;
  onClose: () => void;
  onAuthExpired: () => void;
};
